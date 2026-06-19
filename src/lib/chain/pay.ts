/**
 * Governed agent treasury — REAL, capped, World-ID-gated value movement on World
 * Chain. This is "AgentKit made safe": the agent has its own on-chain wallet, but
 * it can only spend when a verified human approved the EXACT plan (enforced by the
 * caller, never preview/dev), within a hard per-payment cap, and every payment is
 * recorded on-chain + in the sealed, anchored receipt.
 *
 * Sovereign + graceful: if no treasury key is configured or the signer is unfunded,
 * settlement cleanly skips and the step stays authorize-only (client World Wallet
 * path). Never throws — value movement never crashes a mission.
 */
import { getAddress, type Hex } from 'viem';

/**
 * Deterministic, correct EIP-55 validity (TypeScript — NOT LLM-generated). An address
 * is valid iff it is 0x + 40 hex AND (all-lowercase OR all-uppercase → no checksum to
 * verify) OR (mixed-case AND it exactly equals its EIP-55 checksummed form). This is
 * the authoritative validity the treasury and the governance gate enforce, so the
 * agent can never move value to an address that fails it — regardless of what any
 * model-written compute step claims.
 */
export function isValidAddress(addr: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return false;
  const body = addr.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  try { return getAddress(addr) === addr; } catch { return false; }
}
import { chainConfig } from './anchor';

// Hard ceiling per payment (wei), env-overridable. Default ~0.0003 ETH (≈ a few
// cents) — autonomous on-chain spend is capped to demo-safe amounts by default.
const MAX_PAY_WEI = (() => {
  try { return BigInt(process.env.WORLD_AGENT_MAX_PAY_WEI || '300000000000000'); } catch { return 300000000000000n; }
})();
const ETH_USD = Number(process.env.WORLD_AGENT_ETH_USD || '3000');

export interface PayResult {
  ok: boolean;
  txHash?: string;
  explorer?: string;
  chainId?: number;
  from?: string;
  to?: string;
  amountWei?: string;
  capped?: boolean;
  error?: string;
}

/** Pure: convert a USD amount to wei (conservative rate) and clamp to the cap. */
export function usdToCappedWei(amountUsd: number): { wei: bigint; capped: boolean } {
  if (!(amountUsd > 0)) return { wei: 0n, capped: false };
  const raw = BigInt(Math.floor((amountUsd / ETH_USD) * 1e18));
  return raw > MAX_PAY_WEI ? { wei: MAX_PAY_WEI, capped: true } : { wei: raw, capped: false };
}

/** A real World ID nullifier (long hex) — preview/dev sentinels (`dev_…`) are NOT real. */
export function isRealApproval(nullifierHash: string | undefined): boolean {
  return /^0x[0-9a-fA-F]{16,}$/.test(nullifierHash || '');
}

export function treasuryConfigured(): boolean {
  return !!(process.env.WORLD_AGENT_TREASURY_KEY || process.env.WORLD_CHAIN_SIGNER_KEY);
}

/**
 * Execute a governed on-chain payment. The CALLER must already have verified a real
 * human approval — this function additionally caps the amount and never throws.
 */
export async function governedPay(toHex: string, amountWei: bigint, now: () => string): Promise<PayResult & { settledAt?: string }> {
  const pk = process.env.WORLD_AGENT_TREASURY_KEY || process.env.WORLD_CHAIN_SIGNER_KEY;
  if (!pk) return { ok: false, error: 'treasury not configured' };
  // Hard structural guard: the treasury refuses to send to an address that fails
  // deterministic EIP-55 validation — independent of any model-written validation.
  if (!isValidAddress(toHex)) return { ok: false, error: 'recipient failed deterministic EIP-55 validation' };

  const capped = amountWei > MAX_PAY_WEI;
  const value = capped ? MAX_PAY_WEI : amountWei;
  if (value <= 0n) return { ok: false, error: 'amount must be positive' };

  try {
    const { createWalletClient, createPublicClient, http } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { chain, rpc, explorerBase } = await chainConfig();
    const account = privateKeyToAccount(pk as Hex);
    const pub = createPublicClient({ chain, transport: http(rpc) });

    const balance = await pub.getBalance({ address: account.address });
    if (balance <= value) return { ok: false, from: account.address, error: 'treasury balance too low' };

    const wallet = createWalletClient({ account, chain, transport: http(rpc) });
    const txHash = await wallet.sendTransaction({ to: toHex as Hex, value });
    return {
      ok: true,
      txHash,
      explorer: `${explorerBase}${txHash}`,
      chainId: chain.id,
      from: account.address,
      to: toHex,
      amountWei: value.toString(),
      capped,
      settledAt: now(),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
