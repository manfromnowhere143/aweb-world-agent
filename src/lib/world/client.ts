'use client';
/**
 * Client-side World helpers. Inside World App, uses MiniKit for walletAuth (login)
 * and World ID verify (approval). Outside World App, falls back to a dev identity /
 * simulated proof so the full flow is demoable in any browser.
 */
import { MiniKit } from '@worldcoin/minikit-js';
import type { WorldProofPayload } from './verify';

export function inWorldApp(): boolean {
  try {
    return MiniKit.isInstalled();
  } catch {
    return false;
  }
}

export interface Account {
  address: string;
  username?: string;
  dev: boolean;
}

/** Sign in with the World App wallet (SIWE), or a dev identity outside World App. */
export async function login(): Promise<Account> {
  if (!inWorldApp()) {
    return { address: '0xDEV0000000000000000000000000000000000000', username: 'you (dev)', dev: true };
  }
  const { nonce } = await (await fetch('/api/nonce')).json();
  const res = await MiniKit.commandsAsync.walletAuth({
    nonce,
    statement: 'Sign in to Aweb Agent — your governed agent.',
    expirationTime: new Date(Date.now() + 1000 * 60 * 60),
  });
  const payload = (res as { finalPayload: unknown }).finalPayload;
  const verify = await (await fetch('/api/complete-siwe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload, nonce }) })).json();
  if (!verify.isValid) throw new Error('wallet auth failed');
  const address = verify.address as string;
  let username: string | undefined;
  try {
    const u = await MiniKit.getUserByAddress(address);
    username = (u as { username?: string })?.username;
  } catch { /* ignore */ }
  return { address, username, dev: false };
}

export interface PaymentResult { txId: string; status: string; dev: boolean }

/**
 * Settle an authorized payment via the World Wallet (MiniKit Pay). Funds move
 * here, client-side, only after the human's World ID approval of the plan.
 * Outside World App, returns a simulated tx so the governed flow is demoable.
 */
export async function requestPayment(p: { to: string; amountUsd: number; currency: string; reference: string; description: string }): Promise<PaymentResult> {
  if (!inWorldApp()) {
    return { txId: `dev_tx_${p.reference}_${p.amountUsd}${p.currency}`, status: 'simulated', dev: true };
  }
  const mod = (await import('@worldcoin/minikit-js')) as unknown as {
    Tokens: Record<string, string>;
    tokenToDecimals: (amt: number, token: string) => string | number;
  };
  const sym = p.currency === 'USDC' ? (mod.Tokens.USDCE ?? mod.Tokens.USDC ?? 'USDCE') : (mod.Tokens.WLD ?? 'WLD');
  const res = await MiniKit.commandsAsync.pay({
    reference: p.reference,
    to: p.to,
    tokens: [{ symbol: sym as never, token_amount: String(mod.tokenToDecimals(p.amountUsd, sym as never)) }],
    description: p.description,
  } as never);
  const fp = (res as { finalPayload: Record<string, unknown> }).finalPayload;
  if (fp.status === 'error') throw new Error(String(fp.error_code ?? 'payment cancelled'));
  return { txId: String(fp.transaction_id ?? ''), status: String(fp.status ?? 'submitted'), dev: false };
}

/**
 * Obtain a World ID proof approving EXACTLY this plan: the `signal` is the
 * mission plan-hash. Outside World App, returns a simulated payload (the server
 * dev-mode then accepts it).
 */
export async function requestApproval(action: string, signal: string): Promise<WorldProofPayload> {
  // Outside World App → marked preview sentinel (server treats it as non-real).
  if (!inWorldApp()) {
    return { proof: 'dev-proof', merkle_root: 'dev-merkle', nullifier_hash: 'dev-human', verification_level: 'orb' };
  }
  // World ID verify via MiniKit — opens the World App drawer + returns the proof.
  // `signal` is the mission plan-hash (binds approval to the exact plan).
  const res = await MiniKit.commandsAsync.verify({
    action,
    signal,
    verification_level: 'orb' as never,
  });
  const p = (res as { finalPayload: Record<string, unknown> }).finalPayload;
  if (p.status === 'error') throw new Error(String(p.error_code ?? p.detail ?? 'verification cancelled'));
  return {
    proof: String(p.proof),
    merkle_root: String(p.merkle_root),
    nullifier_hash: String(p.nullifier_hash),
    verification_level: (p.verification_level as 'orb' | 'device') ?? 'orb',
  };
}
