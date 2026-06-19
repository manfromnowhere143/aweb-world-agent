/**
 * The single, authoritative governed-mission completion path (non-streaming).
 *
 * Both the internal /api/mission/execute route and the public /api/v1 API call
 * this so there is exactly ONE place where the lifecycle — simulate → World-ID
 * approval → execute → Ed25519 seal → World Chain anchor → persist — is enforced.
 * The streaming /api/mission/run mirrors the same steps for live UX.
 */
import { GovernedMission, GovernanceError } from '@/lib/trust/runtime';
import { policyFromPlan } from '@/lib/agent/policy-from-plan';
import { simulateTool, runTool } from '@/lib/tools';
import { saveMission, saveMemory, FileNullifierRegistry, type StoredMission } from '@/lib/store';
import { verifyWorldApproval, type WorldProofPayload } from '@/lib/world/verify';
import { worldConfig } from '@/lib/world/config';
import { sealReceipt } from '@/lib/trust/signing';
import { anchorSealedReceipt } from '@/lib/chain/anchor';
import { governedPay, usdToCappedWei, isRealApproval, isValidAddress } from '@/lib/chain/pay';
import { appendToChain } from '@/lib/trust/receipt';
import { gatherExecutedSteps, verifyMission, verdictSummary, type MissionVerdict } from '@/lib/agent/verifier';
import { replanRepair } from '@/lib/agent/planner';
import type { ReceiptChain, MissionPlan } from '@/lib/trust/types';

const AUTO_REPAIRABLE = new Set(['READ_ONLY', 'REVERSIBLE']);
const MAX_REPAIR_ROUNDS = 1;

/**
 * Verify → self-repair → re-verify, then append the final verdict. Self-repair is
 * grounded in REAL feedback (failed steps + verifier gaps), not intrinsic "try
 * again" (which the 2026 literature shows degrades). Corrective steps are restricted
 * to auto-approvable risk classes, so the repair loop NEVER runs a sensitive action
 * without a fresh human approval — governance is preserved. Shared by the v1/execute
 * path and the streaming run route (which passes `emit` for live events).
 */
export async function verifyAndRepair(
  receipt: ReceiptChain,
  plan: MissionPlan,
  now: () => string,
  emit?: (type: string, data?: Record<string, unknown>) => void,
): Promise<MissionVerdict> {
  let verdict = await verifyMission(plan.goal, gatherExecutedSteps(receipt));
  emit?.('verified', { verdict: verdict as unknown as Record<string, unknown> });

  let rounds = MAX_REPAIR_ROUNDS;
  while (!verdict.goalMet && rounds-- > 0) {
    const executed = gatherExecutedSteps(receipt);
    const priorSummary = executed.map(s => `- ${s.tool}: ${s.outcome}`).join('\n');
    const corrective = (await replanRepair(plan.goal, verdict.gaps, priorSummary, { now })).filter(s => AUTO_REPAIRABLE.has(s.riskClass));
    if (corrective.length === 0) break; // nothing auto-repairable (would need human approval)

    appendToChain(receipt, 'replan', now(), `Self-repair: ${corrective.length} corrective step(s) from verifier feedback`, {
      gaps: verdict.gaps,
      steps: corrective.map(s => ({ id: s.id, tool: s.tool, intent: s.intent, risk: s.riskClass })),
    });
    emit?.('repairing', { steps: corrective.map(s => ({ id: s.id, tool: s.tool, intent: s.intent })) });

    const priors: Array<{ tool: string; output?: Record<string, unknown> }> = executed.map(s => ({ tool: s.tool, output: s.output }));
    for (const step of corrective) {
      emit?.('step_start', { stepId: step.id, tool: step.tool, intent: step.intent });
      const r = await runTool(step.tool, step.args, priors);
      priors.push({ tool: step.tool, output: r.output });
      appendToChain(receipt, 'execute_step', now(), `Repair: ${step.intent}`, {
        stepId: step.id, tool: step.tool, ok: r.ok, outcome: r.outcome, output: r.output ?? {}, repair: true, error: r.error,
      });
    }
    verdict = await verifyMission(plan.goal, gatherExecutedSteps(receipt));
    emit?.('verified', { verdict: verdict as unknown as Record<string, unknown> });
  }

  appendToChain(receipt, 'verify', now(), verdictSummary(verdict), verdict as unknown as Record<string, unknown>);
  return verdict;
}

/**
 * Governed agent-treasury settlement: pay authorized VALUE_MOVEMENT steps for REAL
 * on World Chain — but ONLY when a real (non-preview) World ID human approval backs
 * the mission, capped per payment, recorded as a sealed+anchored `settle` entry.
 * Skips cleanly otherwise (the step stays authorize-only for the client World Wallet
 * path). Real money moves only on a real human approval — never in preview/dev.
 */
export async function settleGovernedPayments(
  receipt: ReceiptChain,
  now: () => string,
  emit?: (type: string, data?: Record<string, unknown>) => void,
): Promise<void> {
  if (!isRealApproval(receipt.authority.worldIdNullifier)) return;
  const settled = new Set(receipt.entries.filter(e => e.kind === 'settle').map(e => (e.data as { stepId?: string }).stepId));
  const pays = receipt.entries.filter(e => {
    const d = e.data as { tool?: string; stepId?: string; output?: { awaitingSettlement?: boolean } };
    return e.kind === 'execute_step' && d.tool === 'pay' && d.output?.awaitingSettlement && !settled.has(d.stepId);
  });
  for (const e of pays) {
    const d = e.data as { stepId?: string; output?: { to?: string; amountUsd?: number; currency?: string } };
    const to = String(d.output?.to ?? '');
    const amountUsd = Number(d.output?.amountUsd ?? 0);
    if (!to || !(amountUsd > 0)) continue;

    // GOVERNANCE GATE (deterministic recipient validity): the treasury never moves
    // value to an address that fails EIP-55 validation — re-checked here in TS, so it
    // holds no matter what a model-written compute step claimed about the address.
    if (!isValidAddress(to)) {
      appendToChain(receipt, 'blocked', now(), `Payment withheld — recipient ${to.slice(0, 14)}… failed deterministic EIP-55 validation; the governed treasury never moves value to an address that fails validation.`, {
        stepId: d.stepId, reason: 'recipient_invalid', to, amountUsd, withheld: true,
      });
      emit?.('settle_blocked', { stepId: d.stepId, reason: 'recipient failed EIP-55 validation' });
      continue;
    }

    // GOVERNANCE GATE: never move value if a prerequisite step failed. A payment is
    // only justified once the work that earns it has succeeded — so if any earlier
    // (non-repair) execute_step failed, withhold settlement and record WHY. This is
    // the "if valid, pay" guarantee enforced by the runtime, not just prompted.
    const payIdx = receipt.entries.indexOf(e);
    const prerequisiteFailed = receipt.entries.slice(0, payIdx).some(pe => {
      const pd = pe.data as { ok?: boolean; repair?: boolean };
      return pe.kind === 'execute_step' && pd.ok === false && !pd.repair;
    });
    if (prerequisiteFailed) {
      appendToChain(receipt, 'blocked', now(), 'Payment withheld — a prerequisite step failed; the governed treasury does not move value when the work justifying it did not succeed.', {
        stepId: d.stepId, reason: 'prerequisite_step_failed', to, amountUsd, withheld: true,
      });
      emit?.('settle_blocked', { stepId: d.stepId, reason: 'prerequisite step failed' });
      continue;
    }

    const { wei, capped } = usdToCappedWei(amountUsd);
    emit?.('settling', { stepId: d.stepId });
    const r = await governedPay(to, wei, now);
    if (r.ok) {
      // Honest record: the governed treasury settles in NATIVE ETH on World Chain
      // (not USDC / not a user World Wallet payment). We record the actual asset +
      // amount + tx, and keep the originally-requested currency for transparency.
      const ethAmt = r.amountWei ? Number(r.amountWei) / 1e18 : 0;
      const ethStr = ethAmt > 0 ? String(Number(ethAmt.toPrecision(3))) : '0';
      appendToChain(receipt, 'settle', now(), `Governed agent-treasury payment settled on World Chain — ${ethStr} ETH (≈ $${amountUsd}) · tx ${(r.txHash ?? '').slice(0, 12)}…`, {
        stepId: d.stepId, txId: r.txHash, explorer: r.explorer, to, amountUsd,
        asset: 'ETH', settlementRail: 'agent-treasury', requestedCurrency: d.output?.currency ?? 'USDC',
        amountWei: r.amountWei, capped: capped || r.capped, chainId: r.chainId, real: true, treasury: true,
      });
      emit?.('settled', { stepId: d.stepId, txId: r.txHash, explorer: r.explorer });
    } else {
      appendToChain(receipt, 'blocked', now(), `Payment not settled: ${r.error}`, { stepId: d.stepId, reason: r.error });
      emit?.('settle_failed', { stepId: d.stepId, error: r.error });
    }
  }
}

/** Concise, redaction-safe line stored as the human's memory of a mission. */
export function memorySummary(goal: string, v: MissionVerdict): string {
  return `"${goal.slice(0, 160)}" → ${v.goalMet ? 'completed' : 'partial'} (${Math.round(v.confidence * 100)}% confidence)`;
}

export type RunOutcome =
  | { ok: true; missionId: string; state: string; planHash: string; receipt: ReceiptChain }
  | { ok: false; status: number; error: string; signal?: string };

/**
 * Drive a stored, planned mission to a sealed + anchored receipt. Returns a
 * typed outcome (never throws for governance/approval conditions) so callers map
 * it to their own transport (HTTP status, JSON-RPC error, NDJSON event).
 */
export async function completeMission(
  stored: StoredMission,
  args: { proof?: WorldProofPayload; walletAddress?: string },
  now: () => string,
): Promise<RunOutcome> {
  const policy = policyFromPlan(stored.plan);
  const mission = new GovernedMission(stored.plan, policy, { now, registry: new FileNullifierRegistry() });
  if (args.walletAddress) mission.setWalletAuthority(args.walletAddress);

  // Simulate (rebuilds the receipt prefix deterministically, no side effects).
  await mission.simulate(async stepId => {
    const step = stored.plan.steps.find(s => s.id === stepId)!;
    return simulateTool(step.tool, step.args);
  });

  // Gate sensitive steps on a World ID proof bound to the exact plan-hash.
  if (mission.state === 'awaiting_approval') {
    if (!args.proof) {
      return { ok: false, status: 428, error: 'approval required', signal: mission.approvalSignal() };
    }
    const verified = await verifyWorldApproval(args.proof, worldConfig.actionApproveMission, mission.approvalSignal(), now);
    if (!verified.ok || !verified.approval) {
      return { ok: false, status: 401, error: verified.error || 'World ID verification failed' };
    }
    try {
      await mission.approve(verified.approval);
    } catch (e) {
      if (e instanceof GovernanceError) return { ok: false, status: 409, error: e.message };
      throw e;
    }
  }

  // Execute the approved plan with real tools, chaining each step's output forward.
  const priors: Array<{ tool: string; output?: Record<string, unknown> }> = [];
  await mission.execute(async stepId => {
    const step = stored.plan.steps.find(s => s.id === stepId)!;
    const r = await runTool(step.tool, step.args, priors);
    priors.push({ tool: step.tool, output: r.output });
    return { stepId, ok: r.ok, outcome: r.outcome, output: r.output, costUsd: r.costUsd ?? 0, error: r.error };
  });

  const receipt = mission.getReceipt();
  // Governed treasury settlement (real on-chain payment, only on real approval).
  await settleGovernedPayments(receipt, now);
  // Verify (ensemble) → self-repair → re-verify, all before sealing so the verdict
  // and any corrective steps are part of the sealed + anchored evidence.
  const verdict = await verifyAndRepair(receipt, stored.plan, now);

  // Seal: Ed25519-sign the chain head (authenticity), then anchor the sealed root
  // on World Chain (permanent public proof). Anchoring is best-effort and never
  // blocks the sealed receipt.
  receipt.seal = (await sealReceipt(receipt, now)) ?? undefined;
  const anchor = await anchorSealedReceipt(receipt.seal, now);
  if (anchor) receipt.anchor = anchor;
  await saveMission({ ...stored, receipt, state: mission.state });

  // Per-human memory: remember this mission for the verified human (best-effort).
  const subject = args.walletAddress || receipt.authority.worldIdNullifier;
  if (subject) await saveMemory(subject, stored.missionId, memorySummary(stored.plan.goal, verdict), now()).catch(() => {});

  return { ok: true, missionId: stored.missionId, state: mission.state, planHash: mission.planHash, receipt };
}
