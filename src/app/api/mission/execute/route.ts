import { NextRequest, NextResponse } from 'next/server';
import { GovernedMission, GovernanceError } from '@/lib/trust/runtime';
import { policyFromPlan } from '@/lib/agent/policy-from-plan';
import { simulateTool, runTool } from '@/lib/tools';
import { getMission, saveMission, FileNullifierRegistry } from '@/lib/store';
import { verifyWorldApproval, type WorldProofPayload } from '@/lib/world/verify';
import { worldConfig } from '@/lib/world/config';
import { sealReceipt } from '@/lib/trust/signing';

export const runtime = 'nodejs';
const now = () => new Date().toISOString();

export async function POST(req: NextRequest) {
  try {
    const { missionId, proof, walletAddress } = (await req.json()) as {
      missionId?: string;
      proof?: WorldProofPayload;
      walletAddress?: string;
    };
    if (!missionId) return NextResponse.json({ error: 'missionId required' }, { status: 400 });

    const stored = await getMission(missionId);
    if (!stored) return NextResponse.json({ error: 'mission not found' }, { status: 404 });

    const policy = policyFromPlan(stored.plan);
    const mission = new GovernedMission(stored.plan, policy, { now, registry: new FileNullifierRegistry() });
    if (walletAddress) mission.setWalletAuthority(walletAddress);

    // Simulate (rebuilds the receipt prefix deterministically).
    await mission.simulate(async stepId => {
      const step = stored.plan.steps.find(s => s.id === stepId)!;
      return simulateTool(step.tool, step.args);
    });

    // If sensitive steps exist, require + verify a World ID approval bound to the plan-hash.
    if (mission.state === 'awaiting_approval') {
      if (!proof) {
        return NextResponse.json({ error: 'approval required', signal: mission.approvalSignal() }, { status: 428 });
      }
      const verified = await verifyWorldApproval(proof, worldConfig.actionApproveMission, mission.approvalSignal(), now);
      if (!verified.ok || !verified.approval) {
        return NextResponse.json({ error: verified.error || 'World ID verification failed' }, { status: 401 });
      }
      try {
        await mission.approve(verified.approval);
      } catch (e) {
        if (e instanceof GovernanceError) return NextResponse.json({ error: e.message }, { status: 409 });
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
    // Seal: Ed25519-sign the chain head so the receipt is authentic, not just tamper-evident.
    receipt.seal = (await sealReceipt(receipt, now)) ?? undefined;
    await saveMission({ ...stored, receipt, state: mission.state });

    return NextResponse.json({ missionId, state: mission.state, planHash: mission.planHash, receipt });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
