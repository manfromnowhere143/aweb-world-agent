import { NextRequest, NextResponse } from 'next/server';
import { GovernanceError } from '@/lib/trust/runtime';
import { createMission } from '@/lib/agent/create-mission';

export const runtime = 'nodejs';
const now = () => new Date().toISOString();

export async function POST(req: NextRequest) {
  try {
    const { goal, walletAddress } = (await req.json()) as { goal?: string; walletAddress?: string };
    if (!goal || goal.trim().length < 3) {
      return NextResponse.json({ error: 'Tell the agent what to do (a sentence).' }, { status: 400 });
    }
    const created = await createMission(goal, now, walletAddress);
    return NextResponse.json(created);
  } catch (e) {
    if (e instanceof GovernanceError) {
      return NextResponse.json({ error: `Plan blocked by policy: ${e.message}` }, { status: 422 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
