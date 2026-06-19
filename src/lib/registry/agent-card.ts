/**
 * The Aweb Agent registration card — the discovery + trust descriptor other apps,
 * agents, and x402 services read to decide whether to trust this agent.
 *
 * Standards-aligned (not bespoke):
 *  • ERC-8004 "Trustless Agents" (Identity → off-chain JSON; trust models; on-chain handle)
 *  • Google A2A "agent card" (/.well-known/agent-card.json discovery)
 *  • EAS / "Execution Receipts for AI Agents" (off-chain evidence + on-chain root + session proof)
 *
 * Aweb's differentiator over plain ERC-8004: the identity is bound to a UNIQUE
 * VERIFIED HUMAN via World ID, and every action carries a governed, sealed,
 * on-chain-anchored receipt — proof-of-personhood + proof-of-behavior.
 */
import { TOOLS } from '../tools';
import { worldConfig } from '../world/config';
import { anchorSignerAddress } from '../chain/anchor';

const SITE = 'https://agent.aweblabs.ai';

export interface AgentCard {
  schemaVersion: string;
  standards: string[];
  name: string;
  description: string;
  homepage: string;
  provider: { name: string; url: string };
  identity: {
    humansOnly: boolean;
    proofOfPersonhood: 'world-id';
    worldIdRp: string | null;
    worldAppId: string | null;
    bindingRule: string;
  };
  registration: { agentAddress: string | null; chain: string; chainId: number };
  trustModels: string[];
  endpoints: Record<string, string>;
  receiptStandard: {
    name: string; version: string; schema: string; model: string;
    anchor: { chain: string; chainId: number; explorer: string };
    verify: string;
  };
  capabilities: Array<{ name: string; riskClass: string; description: string }>;
  reputation: { total: number; completed: number; last7d: number; query: string };
  generatedAt: string;
}

export async function buildAgentCard(
  stats: { total: number; completed: number; last7d: number },
  now: () => string,
): Promise<AgentCard> {
  const chainId = (process.env.WORLD_CHAIN_NETWORK || 'mainnet').toLowerCase() === 'sepolia' ? 4801 : 480;
  const agentAddress = await anchorSignerAddress().catch(() => null);
  return {
    schemaVersion: '1.0',
    standards: ['ERC-8004', 'A2A', 'EAS-execution-receipts'],
    name: 'Aweb Agent',
    description:
      'A governed personal agent for verified humans on World. It plans, simulates, requires the human to approve anything sensitive with World ID (bound to the exact plan), executes across real tools, and emits a hash-chained, Ed25519-sealed, on-chain-anchored receipt for every action.',
    homepage: SITE,
    provider: { name: 'Aweb Labs', url: 'https://aweblabs.ai' },
    identity: {
      humansOnly: true,
      proofOfPersonhood: 'world-id',
      worldIdRp: worldConfig.rpId || null,
      worldAppId: worldConfig.appId || null,
      bindingRule: 'one verified human (World ID nullifier) ↔ one accountable agent; sensitive actions require a World ID proof whose signal is the SHA-256 of the exact plan',
    },
    registration: { agentAddress, chain: 'World Chain', chainId },
    trustModels: ['world-id-approval', 'ed25519-sealed-receipts', 'onchain-anchor', 'adversarial-self-verification', 'governed-value-caps'],
    endpoints: {
      api: `${SITE}/api/v1`,
      mcp: `${SITE}/api/mcp`,
      openapi: `${SITE}/api/v1/openapi.json`,
      receiptSchema: `${SITE}/api/v1/registry/receipt-schema`,
      reputation: `${SITE}/api/v1/registry/reputation/{subject}`,
      verifyReceipt: `${SITE}/api/v1/receipts/{missionId}/verify?onchain=1`,
    },
    receiptStandard: {
      name: 'Aweb Agent Receipt',
      version: '1.0',
      schema: `${SITE}/api/v1/registry/receipt-schema`,
      model: 'off-chain evidence (full hash-chained receipt) + on-chain root (32-byte chain head as World Chain calldata) + Ed25519 session proof over the head',
      anchor: { chain: 'World Chain', chainId, explorer: 'https://worldscan.org' },
      verify: `${SITE}/api/v1/receipts/{missionId}/verify?onchain=1`,
    },
    capabilities: TOOLS.map(t => ({ name: t.slug, riskClass: t.riskClass, description: t.description })),
    reputation: { ...stats, query: `${SITE}/api/v1/registry/reputation/{subject}` },
    generatedAt: now(),
  };
}
