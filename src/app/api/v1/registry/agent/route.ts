/**
 * GET /api/v1/registry/agent — the Aweb Agent registration card (also served at
 * /.well-known/agent-card.json). ERC-8004 / A2A-aligned discovery + trust descriptor.
 */
import { buildAgentCard } from '@/lib/registry/agent-card';
import { missionStats } from '@/lib/store';
import { json, preflight } from '@/lib/api/http';

export const runtime = 'nodejs';
const now = () => new Date().toISOString();

export function OPTIONS() {
  return preflight();
}

export async function GET() {
  const stats = await missionStats().catch(() => ({ total: 0, completed: 0, last7d: 0 }));
  return json(await buildAgentCard(stats, now));
}
