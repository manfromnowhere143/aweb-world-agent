import { NextRequest } from 'next/server';
import { GovernedMission, GovernanceError } from '@/lib/trust/runtime';
import { policyFromPlan } from '@/lib/agent/policy-from-plan';
import { simulateTool, runTool } from '@/lib/tools';
import { getMission, saveMission, saveMemory, FileNullifierRegistry } from '@/lib/store';
import { verifyWorldApproval, type WorldProofPayload } from '@/lib/world/verify';
import { worldConfig } from '@/lib/world/config';
import { sealReceipt } from '@/lib/trust/signing';
import { anchorSealedReceipt } from '@/lib/chain/anchor';
import { verifyAndRepair, settleGovernedPayments, memorySummary } from '@/lib/agent/run-mission';

export const runtime = 'nodejs';
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Streams the governed mission lifecycle as NDJSON events so the client can show
 * each step (plan → simulate → approve → execute → seal) live, exposing the
 * governance as it happens.
 */
export async function POST(req: NextRequest) {
  const { missionId, proof, walletAddress } = (await req.json()) as {
    missionId?: string;
    proof?: WorldProofPayload;
    walletAddress?: string;
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      try {
        if (!missionId) throw new Error('missionId required');
        const stored = await getMission(missionId);
        if (!stored) throw new Error('mission not found');

        const policy = policyFromPlan(stored.plan);
        const mission = new GovernedMission(stored.plan, policy, {
          now,
          registry: new FileNullifierRegistry(),
          onEntry: entry => send({ type: 'entry', entry }),
          onStepStart: step => send({ type: 'step_start', stepId: step.id, tool: step.tool, intent: step.intent }),
        });
        if (walletAddress) mission.setWalletAuthority(walletAddress);

        await sleep(180);
        await mission.simulate(async stepId => {
          const step = stored.plan.steps.find(s => s.id === stepId)!;
          await sleep(140);
          return simulateTool(step.tool, step.args);
        });

        if (mission.state === 'awaiting_approval') {
          if (!proof) { send({ type: 'need_approval', signal: mission.approvalSignal() }); controller.close(); return; }
          const verified = await verifyWorldApproval(proof, worldConfig.actionApproveMission, mission.approvalSignal(), now);
          if (!verified.ok || !verified.approval) throw new Error(verified.error || 'World ID verification failed');
          try { await mission.approve(verified.approval); }
          catch (e) { if (e instanceof GovernanceError) throw new Error(e.message); throw e; }
        }

        await sleep(180);
        const priors: Array<{ tool: string; output?: Record<string, unknown> }> = [];
        await mission.execute(async stepId => {
          const step = stored.plan.steps.find(s => s.id === stepId)!;
          const r = await runTool(step.tool, step.args, priors);
          priors.push({ tool: step.tool, output: r.output });
          return { stepId, ok: r.ok, outcome: r.outcome, output: r.output, costUsd: r.costUsd ?? 0, error: r.error };
        });

        const receipt = mission.getReceipt();

        // Verify (ensemble) → self-repair → re-verify, streamed live. The verdict +
        // any corrective steps are recorded before sealing, so they're sealed + anchored.
        // Governed treasury settlement (real on-chain, only on real approval).
        await settleGovernedPayments(receipt, now, (type, data) => send({ type, ...(data || {}) }));

        send({ type: 'verifying' });
        const verdict = await verifyAndRepair(receipt, stored.plan, now, (type, data) => send({ type, ...(data || {}) }));

        send({ type: 'sealing' });
        await sleep(220);
        receipt.seal = (await sealReceipt(receipt, now)) ?? undefined;
        await saveMission({ ...stored, receipt, state: mission.state });

        // Anchor the sealed root on World Chain — a permanent, public proof. Best-effort:
        // skips cleanly if the signer is unset/unfunded, never blocking the sealed receipt.
        send({ type: 'anchoring' });
        const anchor = await anchorSealedReceipt(receipt.seal, now);
        if (anchor) {
          receipt.anchor = anchor;
          await saveMission({ ...stored, receipt, state: mission.state });
          send({ type: 'anchored', anchor });
        }

        // Per-human memory: remember this mission for the verified human (best-effort).
        const subject = walletAddress || receipt.authority.worldIdNullifier;
        if (subject) await saveMemory(subject, stored.missionId, memorySummary(stored.plan.goal, verdict), now()).catch(() => {});

        send({ type: 'done', state: mission.state, planHash: mission.planHash, receipt });
      } catch (e) {
        send({ type: 'error', error: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
  });
}
