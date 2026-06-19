/**
 * GET /api/v1 — developer index for the Aweb Agent public API.
 */
import { json, preflight } from '@/lib/api/http';
import { keysConfigured } from '@/lib/api/auth';
import { missionStats } from '@/lib/store';

export const runtime = 'nodejs';

export function OPTIONS() {
  return preflight();
}

export async function GET() {
  const stats = await missionStats().catch(() => ({ total: 0, completed: 0, last7d: 0 }));
  return json({
    name: 'Aweb Agent API',
    version: 'v1',
    description: 'Governance + verifiable, on-chain-anchored receipts for the verified-human agent economy on World.',
    writesGated: keysConfigured(),
    stats,
    endpoints: {
      'POST /api/v1/human/session': 'Exchange a World ID (verify-human) proof for a verified-human session token.',
      'GET /api/v1/keys': 'List your API keys (verified-human session).',
      'POST /api/v1/keys': 'Mint a new API key — secret shown once (verified-human session).',
      'DELETE /api/v1/keys/:id': 'Revoke one of your keys (verified-human session).',
      'POST /api/v1/missions': 'Create + plan a governed mission (key-gated).',
      'GET /api/v1/missions/:id': 'Mission status + plan.',
      'POST /api/v1/missions/:id/execute': 'Execute to a sealed + anchored receipt (key-gated; World ID proof for sensitive steps).',
      'GET /api/v1/receipts/:id': 'Full verifiable receipt + attestation (public; ?onchain=1 verifies anchor calldata).',
      'GET /api/v1/receipts/:id/verify': 'Attestation only (public; ?onchain=1).',
      'POST /api/mcp': 'MCP server (Streamable HTTP, JSON-RPC 2.0) — same surface for agents.',
      'GET /api/v1/openapi.json': 'OpenAPI 3.1 specification.',
      'GET /.well-known/agent-card.json': 'ERC-8004 / A2A agent registration card (discovery + trust).',
      'GET /api/v1/registry/agent': 'Agent registration card.',
      'GET /api/v1/registry/receipt-schema': 'The open Aweb Agent Receipt standard (EAS / ERC-8004 aligned).',
      'GET /api/v1/registry/reputation/:subject': 'Governed, receipt-backed track record for a verified human’s agent.',
    },
    standards: ['ERC-8004', 'A2A', 'EAS-execution-receipts'],
    thesis: 'World proves a human is behind the agent. Aweb proves the agent behaved.',
  });
}
