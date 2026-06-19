import { NextRequest, NextResponse } from 'next/server';
import { getMission } from '@/lib/store';
import { completeMission } from '@/lib/agent/run-mission';
import type { WorldProofPayload } from '@/lib/world/verify';

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

    const result = await completeMission(stored, { proof, walletAddress }, now);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, ...(result.signal ? { signal: result.signal } : {}) }, { status: result.status });
    }
    return NextResponse.json({ missionId: result.missionId, state: result.state, planHash: result.planHash, receipt: result.receipt });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
