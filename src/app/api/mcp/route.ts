/**
 * Aweb Agent MCP server — Streamable HTTP transport (JSON-RPC 2.0).
 *
 * Exposes the governed agent + verifiable-receipt surface as MCP tools so ANY
 * MCP client (Claude, other agents, the x402 web) can: create a governed
 * mission, execute it (with a World ID proof when sensitive), fetch a receipt,
 * and independently verify it — including the on-chain anchor. This is the
 * "shared ecosystem infrastructure" the grant thesis promises, callable by
 * machines, not just the mini app UI.
 *
 * Mutating tools (create/execute) honor the same API-key gate as the REST API
 * (Authorization: Bearer …). Read/verify tools are open — proofs are public.
 */
import { getMission, missionStats } from '@/lib/store';
import { createMission } from '@/lib/agent/create-mission';
import { completeMission } from '@/lib/agent/run-mission';
import { attestReceipt } from '@/lib/trust/verify-server';
import { GovernanceError } from '@/lib/trust/runtime';
import { authenticateAsync } from '@/lib/api/auth';
import { CORS_HEADERS, rateGuard } from '@/lib/api/http';
import type { WorldProofPayload } from '@/lib/world/verify';

export const runtime = 'nodejs';
const now = () => new Date().toISOString();

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'aweb-world-agent', version: '1.0.0', title: 'Aweb Agent — governance + receipts for World' };

const TOOLS = [
  {
    name: 'world_mission_create',
    title: 'Create a governed mission',
    description:
      'Plan a governed agent mission from a natural-language goal. Returns a typed, frozen plan, its plan-hash (the World ID approval signal), and whether human approval is required before sensitive steps. Key-gated.',
    inputSchema: {
      type: 'object',
      properties: { goal: { type: 'string', description: 'What the agent should do (a sentence).' } },
      required: ['goal'],
    },
  },
  {
    name: 'world_mission_execute',
    title: 'Execute a governed mission',
    description:
      'Run a planned mission to a sealed + anchored receipt. If the plan has sensitive steps, pass a World ID `proof` bound to the plan-hash; otherwise an approval-required result with the `signal` to sign is returned. Key-gated.',
    inputSchema: {
      type: 'object',
      properties: {
        missionId: { type: 'string' },
        proof: { type: 'object', description: 'World ID cloud proof bound to the plan-hash signal (optional for read-only plans).' },
        walletAddress: { type: 'string' },
      },
      required: ['missionId'],
    },
  },
  {
    name: 'world_mission_status',
    title: 'Get mission status',
    description: 'Return a mission’s plan + lifecycle state. Public read.',
    inputSchema: { type: 'object', properties: { missionId: { type: 'string' } }, required: ['missionId'] },
  },
  {
    name: 'world_receipt_get',
    title: 'Get a verifiable receipt',
    description: 'Fetch the full hash-chained, Ed25519-sealed, World-Chain-anchored receipt for a mission, plus a server attestation. Public.',
    inputSchema: {
      type: 'object',
      properties: { missionId: { type: 'string' }, onchain: { type: 'boolean', description: 'Also verify the anchor calldata on World Chain.' } },
      required: ['missionId'],
    },
  },
  {
    name: 'world_receipt_verify',
    title: 'Verify a receipt',
    description: 'Return only the attestation (integrity ∧ authenticity ∧ anchor). With onchain=true, reads the anchor tx calldata from World Chain and confirms it equals the sealed root — trustless. Public.',
    inputSchema: {
      type: 'object',
      properties: { missionId: { type: 'string' }, onchain: { type: 'boolean' } },
      required: ['missionId'],
    },
  },
  {
    name: 'world_stats',
    title: 'Mission stats',
    description: 'Aggregate mission counts (total / completed / last 7 days).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'world_agent_card',
    title: 'Agent registration card',
    description: 'The ERC-8004 / A2A-aligned registration card: identity (World-ID-bound), trust models, endpoints, the open receipt standard, and reputation. Use this to discover + decide whether to trust this agent. Public.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'world_agent_reputation',
    title: 'Agent reputation / track record',
    description: 'The governed, receipt-backed track record of a verified human’s agent (subject = World ID nullifier or wallet). ERC-8004 reputation spirit. Public.',
    inputSchema: { type: 'object', properties: { subject: { type: 'string' } }, required: ['subject'] },
  },
];

type JsonRpcId = string | number | null;
interface JsonRpcRequest { jsonrpc: '2.0'; id?: JsonRpcId; method: string; params?: Record<string, unknown> }

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}
function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0' as const, id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
function toolOk(structured: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured as Record<string, unknown> };
}
function toolErr(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function callTool(name: string, args: Record<string, unknown>, req: Request): Promise<unknown> {
  switch (name) {
    case 'world_mission_create': {
      if (!(await authenticateAsync(req))) return toolErr('unauthorized — provide a Bearer API key');
      const goal = String(args.goal ?? '').trim();
      if (goal.length < 3) return toolErr('goal required (a sentence)');
      try {
        return toolOk(await createMission(goal, now));
      } catch (e) {
        if (e instanceof GovernanceError) return toolErr(`plan blocked by policy: ${e.message}`);
        throw e;
      }
    }
    case 'world_mission_execute': {
      if (!(await authenticateAsync(req))) return toolErr('unauthorized — provide a Bearer API key');
      const stored = await getMission(String(args.missionId ?? ''));
      if (!stored) return toolErr('mission not found');
      const result = await completeMission(
        stored,
        { proof: args.proof as WorldProofPayload | undefined, walletAddress: args.walletAddress as string | undefined },
        now,
      );
      if (!result.ok) return toolOk({ ok: false, error: result.error, ...(result.signal ? { signal: result.signal } : {}) });
      return toolOk({ ok: true, missionId: result.missionId, state: result.state, planHash: result.planHash, receipt: result.receipt });
    }
    case 'world_mission_status': {
      const m = await getMission(String(args.missionId ?? ''));
      if (!m) return toolErr('mission not found');
      return toolOk({ missionId: m.missionId, goal: m.plan.goal, state: m.state, planHash: m.planHash, hasReceipt: !!m.receipt, plan: m.plan });
    }
    case 'world_receipt_get': {
      const m = await getMission(String(args.missionId ?? ''));
      if (!m?.receipt) return toolErr('receipt not found');
      const attestation = await attestReceipt(m.receipt, now, { verifyOnChain: args.onchain === true });
      return toolOk({ missionId: m.missionId, goal: m.plan.goal, planHash: m.planHash, state: m.state, receipt: m.receipt, attestation });
    }
    case 'world_receipt_verify': {
      const m = await getMission(String(args.missionId ?? ''));
      if (!m?.receipt) return toolErr('receipt not found');
      return toolOk(await attestReceipt(m.receipt, now, { verifyOnChain: args.onchain === true }));
    }
    case 'world_stats':
      return toolOk(await missionStats());
    case 'world_agent_card': {
      const { buildAgentCard } = await import('@/lib/registry/agent-card');
      return toolOk(await buildAgentCard(await missionStats(), now));
    }
    case 'world_agent_reputation': {
      const { recallMemory } = await import('@/lib/store');
      const subject = String(args.subject ?? '');
      if (!subject) return toolErr('subject required');
      const history = await recallMemory(subject, 50);
      const completed = history.filter(m => /completed/i.test(m.summary)).length;
      return toolOk({ subject, missions: history.length, completed, recent: history.slice(0, 10).map(m => ({ missionId: m.missionId, summary: m.summary, at: m.createdAt })) });
    }
    default:
      return toolErr(`unknown tool: ${name}`);
  }
}

async function handleRpc(msg: JsonRpcRequest, req: Request): Promise<object | null> {
  const id = msg.id ?? null;
  switch (msg.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Governance + verifiable receipts for the verified-human agent economy on World. Create a mission, execute it (World ID proof gates sensitive steps), then fetch/verify its on-chain-anchored receipt.',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notification — no response
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const params = msg.params ?? {};
      const name = String(params.name ?? '');
      const args = (params.arguments as Record<string, unknown>) ?? {};
      const tool = TOOLS.find(t => t.name === name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
      try {
        return rpcResult(id, await callTool(name, args, req));
      } catch (e) {
        return rpcError(id, -32603, e instanceof Error ? e.message : String(e));
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// Discovery convenience: GET returns server info + tool list (not part of the
// JSON-RPC transport, but handy for humans hitting the endpoint in a browser).
export function GET() {
  return Response.json(
    { serverInfo: SERVER_INFO, protocolVersion: PROTOCOL_VERSION, transport: 'streamable-http (POST JSON-RPC)', tools: TOOLS.map(t => ({ name: t.name, title: t.title })) },
    { headers: CORS_HEADERS },
  );
}

export async function POST(req: Request) {
  const limited = await rateGuard(req, 'mcp', 60); if (limited) return limited;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(rpcError(null, -32700, 'parse error'), { status: 400, headers: CORS_HEADERS });
  }

  // Support a single message or a JSON-RPC batch.
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(m => handleRpc(m as JsonRpcRequest, req)))).filter(Boolean);
    if (responses.length === 0) return new Response(null, { status: 202, headers: CORS_HEADERS });
    return Response.json(responses, { headers: CORS_HEADERS });
  }

  const res = await handleRpc(body as JsonRpcRequest, req);
  if (res === null) return new Response(null, { status: 202, headers: CORS_HEADERS });
  return Response.json(res, { headers: CORS_HEADERS });
}
