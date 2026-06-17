/**
 * GovernedMission — the lifecycle state machine that enforces:
 *
 *   plan → simulate → (World ID approval if sensitive) → execute → receipt
 *
 * Nothing sensitive executes without a valid World-ID-bound approval whose
 * signal is the mission plan-hash. Every transition appends a hash-chained
 * receipt. No Date/random in core — callers inject `now()` for determinism.
 */
import { sha256Hex } from './hash';
import { evaluatePlan, type PlanEvaluation } from './policy';
import { ReceiptBuilder } from './receipt';
import { InMemoryNullifierRegistry, type NullifierRegistry } from './nullifier-registry';
import type {
  MissionPlan,
  MissionState,
  PolicyConfig,
  StepResult,
  WorldIdApproval,
} from './types';

export interface RuntimeOptions {
  now: () => string; // ISO timestamp provider
  registry?: NullifierRegistry;
  acceptedVerificationLevels?: Array<'orb' | 'device'>;
  onEntry?: (entry: import('./types').ReceiptEntry) => void; // live receipt stream
  onStepStart?: (step: import('./types').MissionStep) => void; // fires before a step runs
}

export class GovernanceError extends Error {}

export class GovernedMission {
  state: MissionState = 'planned';
  planHash = '';
  private evaluation!: PlanEvaluation;
  private receipt: ReceiptBuilder;
  private registry: NullifierRegistry;
  private now: () => string;
  private accepted: Array<'orb' | 'device'>;
  private onStepStart?: (step: import('./types').MissionStep) => void;

  constructor(
    public plan: MissionPlan,
    public policy: PolicyConfig,
    opts: RuntimeOptions,
  ) {
    this.now = opts.now;
    this.registry = opts.registry ?? new InMemoryNullifierRegistry();
    this.accepted = opts.acceptedVerificationLevels ?? ['orb', 'device'];
    this.onStepStart = opts.onStepStart;
    // Freeze + hash the plan; the hash is what a human approves via World ID.
    this.planHash = sha256Hex(this.plan);
    this.receipt = new ReceiptBuilder(this.plan.missionId, this.planHash, {}, opts.onEntry);
    this.evaluation = evaluatePlan(this.plan, this.policy);
    this.receipt.append('plan', this.now(), `Mission planned: ${this.plan.goal}`, {
      planHash: this.planHash,
      steps: this.plan.steps.map(s => ({ id: s.id, tool: s.tool, risk: s.riskClass, intent: s.intent, valueUsd: s.valueUsd })),
      evaluation: this.evaluation.evaluations,
      valueCapUsd: this.policy.valueCapUsd,
    });
    if (this.evaluation.denied.length) {
      this.state = 'failed';
      this.receipt.append('blocked', this.now(), 'Plan denied by policy before execution', { denied: this.evaluation.denied });
      throw new GovernanceError(`plan denied: ${this.evaluation.denied.map(d => d.reason).join('; ')}`);
    }
  }

  /** The value to pass as the World ID `signal` so the proof binds to this plan. */
  approvalSignal(): string {
    return this.planHash;
  }

  /** Dry-run every step (no external side effects). */
  async simulate(simulateStep: (stepId: string) => Promise<{ expected: string; output?: Record<string, unknown> }>) {
    if (this.state !== 'planned') throw new GovernanceError(`cannot simulate from state '${this.state}'`);
    const sims = [];
    for (const step of this.plan.steps) {
      const r = await simulateStep(step.id);
      sims.push({ stepId: step.id, tool: step.tool, expected: r.expected, output: r.output ?? {} });
    }
    this.receipt.append('simulate', this.now(), 'Simulated all steps (no side effects)', { simulations: sims });
    if (this.evaluation.needsApproval) {
      this.state = 'awaiting_approval';
      this.receipt.append('await_approval', this.now(), 'Sensitive steps require a verified-human approval', {
        signal: this.approvalSignal(),
        needs: this.evaluation.evaluations.filter(e => e.decision === 'needs_approval').map(e => e.stepId),
      });
    } else {
      // No sensitive steps — auto-approved, but still receipted.
      this.state = 'approved';
      this.receipt.append('approve', this.now(), 'Auto-approved: no sensitive steps', { auto: true });
    }
    return sims;
  }

  /** Apply a World ID approval. Validates plan binding, level, and single-use. */
  async approve(approval: WorldIdApproval) {
    if (this.state !== 'awaiting_approval') throw new GovernanceError(`cannot approve from state '${this.state}'`);
    if (approval.signalHash !== this.approvalSignal()) {
      throw new GovernanceError('approval signal does not match this plan (hash mismatch)');
    }
    if (!this.accepted.includes(approval.verificationLevel)) {
      throw new GovernanceError(`verification level '${approval.verificationLevel}' not accepted`);
    }
    if (await this.registry.isUsed(approval.nullifierHash, approval.signalHash)) {
      throw new GovernanceError('approval already used (anti-replay)');
    }
    await this.registry.markUsed(approval.nullifierHash, approval.signalHash);
    this.receipt.setAuthority({ worldIdNullifier: approval.nullifierHash, verificationLevel: approval.verificationLevel });
    this.state = 'approved';
    this.receipt.append('approve', this.now(), 'Verified human approved this exact plan', {
      nullifierHash: approval.nullifierHash,
      verificationLevel: approval.verificationLevel,
      signalHash: approval.signalHash,
      proof: approval.proof, // redacted by the receipt builder
      merkleRoot: approval.merkleRoot,
    });
  }

  /** Record the wallet (SIWE) behind this mission in the receipt authority. */
  setWalletAuthority(walletAddress: string) {
    this.receipt.setAuthority({ walletAddress });
  }

  reject(reason: string) {
    if (this.state === 'completed') throw new GovernanceError('cannot reject a completed mission');
    this.state = 'rejected';
    this.receipt.append('reject', this.now(), 'Human rejected the mission', { reason });
  }

  /** Execute the approved plan. Enforces allowlist + cumulative value cap. */
  async execute(executeStep: (stepId: string) => Promise<StepResult>) {
    if (this.state !== 'approved') throw new GovernanceError(`cannot execute from state '${this.state}'`);
    this.state = 'executing';
    let spent = 0;
    let failed = false;
    for (const step of this.plan.steps) {
      const evalr = this.evaluation.evaluations.find(e => e.stepId === step.id)!;
      if (evalr.decision === 'denied') {
        this.receipt.append('blocked', this.now(), `Step blocked: ${step.intent}`, { stepId: step.id, reason: evalr.reason });
        continue;
      }
      if (step.riskClass === 'VALUE_MOVEMENT') {
        const projected = spent + (step.valueUsd ?? 0);
        if (projected > this.policy.valueCapUsd) {
          this.receipt.append('blocked', this.now(), `Step blocked: would exceed value cap`, { stepId: step.id, projected, cap: this.policy.valueCapUsd });
          continue;
        }
      }
      this.onStepStart?.(step);
      const result = await executeStep(step.id);
      if (step.riskClass === 'VALUE_MOVEMENT' && result.ok) spent += step.valueUsd ?? 0;
      if (!result.ok) failed = true;
      this.receipt.append('execute_step', this.now(), `${result.ok ? 'Executed' : 'Failed'}: ${step.intent}`, {
        stepId: step.id,
        tool: step.tool,
        ok: result.ok,
        outcome: result.outcome,
        output: result.output ?? {},
        costUsd: result.costUsd ?? 0,
        error: result.error,
      });
    }
    this.state = failed ? 'failed' : 'completed';
    this.receipt.append('complete', this.now(), failed ? 'Mission completed with failures' : 'Mission completed', {
      state: this.state,
      totalSpentUsd: spent,
    });
  }

  getReceipt() {
    return this.receipt.chain();
  }

  getEvaluation() {
    return this.evaluation;
  }
}
