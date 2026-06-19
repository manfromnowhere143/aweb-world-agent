/**
 * GET /api/v1/registry/reputation/:subject — the public, governed track record of
 * one verified human's agent (subject = World ID nullifier or wallet address). The
 * ERC-8004 "reputation registry" spirit: composable, queryable signals any app can
 * check before trusting this agent — backed by sealed + on-chain-anchored receipts.
 */
import { recallMemory } from '@/lib/store';
import { json, apiError, preflight } from '@/lib/api/http';

export const runtime = 'nodejs';
const SITE = 'https://agent.aweblabs.ai';

export function OPTIONS() {
  return preflight();
}

export async function GET(_req: Request, { params }: { params: Promise<{ subject: string }> }) {
  const { subject } = await params;
  if (!subject) return apiError('subject required', 400);

  const history = await recallMemory(subject, 50).catch(() => []);
  const missions = history.length;
  const completed = history.filter(m => /completed/i.test(m.summary)).length;
  const recent = history.slice(0, 10).map(m => ({
    missionId: m.missionId,
    summary: m.summary,
    at: m.createdAt,
    receipt: m.missionId ? `${SITE}/receipt/${m.missionId}` : null,
    verify: m.missionId ? `${SITE}/api/v1/receipts/${m.missionId}/verify?onchain=1` : null,
  }));

  return json({
    agent: 'Aweb Agent',
    subject, // the verified human this agent is bound to (World ID nullifier / wallet)
    standard: 'ERC-8004 reputation (governed, receipt-backed)',
    trackRecord: {
      missions,
      completed,
      completionRate: missions ? Math.round((completed / missions) * 100) / 100 : null,
    },
    recent,
    note: 'Every mission is governed (World-ID-approved when sensitive) and backed by a hash-chained, Ed25519-sealed, on-chain-anchored receipt. Verify any of them yourself via the verify links.',
  });
}
