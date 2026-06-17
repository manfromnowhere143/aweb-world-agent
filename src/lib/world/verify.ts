/**
 * Server-side World ID proof verification.
 *
 * The client obtains a World ID proof where the `signal` is the mission
 * plan-hash. We verify it against World's cloud API; on success we build a
 * WorldIdApproval whose `signalHash` is that plan-hash, which the Trust Runtime
 * checks against the live mission (binding the human's approval to the exact plan).
 *
 * Dev mode returns a deterministic mock approval so the loop is testable offline.
 */
import { sha256Hex } from '../trust/hash';
import type { WorldIdApproval } from '../trust/types';
import { isDevMode, worldConfig } from './config';

export interface TxVerifyResult {
  ok: boolean;
  status?: string;
  reference?: string;
  error?: string;
  dev?: boolean;
}

/**
 * Verify a World Wallet payment transaction server-side via the Developer Portal.
 * Dev mode accepts simulated tx ids so the governed settlement is testable offline.
 */
export async function verifyWorldTransaction(txId: string, reference: string): Promise<TxVerifyResult> {
  if (isDevMode() || txId.startsWith('dev_tx_')) {
    return { ok: true, status: 'settled', reference, dev: true };
  }
  if (!worldConfig.appId) return { ok: false, error: 'World App ID not configured' };
  try {
    const res = await fetch(
      `https://developer.worldcoin.org/api/v2/minikit/transaction/${txId}?app_id=${worldConfig.appId}&type=payment`,
      { headers: { 'content-type': 'application/json' } },
    );
    const body = (await res.json().catch(() => ({}))) as { reference?: string; transaction_status?: string; status?: string };
    const status = body.transaction_status ?? body.status;
    if (!res.ok || status === 'failed') return { ok: false, status, error: `transaction not confirmed (${status ?? res.status})` };
    if (body.reference && reference && body.reference !== reference) return { ok: false, error: 'payment reference mismatch' };
    return { ok: true, status: status ?? 'submitted', reference: body.reference };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Raw proof payload as returned by MiniKit/IDKit on the client. */
export interface WorldProofPayload {
  proof: string;
  merkle_root: string;
  nullifier_hash: string;
  verification_level: 'orb' | 'device';
}

export interface VerifyResult {
  ok: boolean;
  approval?: WorldIdApproval;
  error?: string;
  dev?: boolean;
}

/**
 * Verify a World ID proof for an approval bound to `signal` (the plan-hash).
 * @param now ISO timestamp provider (injected — no Date in shared logic).
 */
export async function verifyWorldApproval(
  payload: WorldProofPayload,
  action: string,
  signal: string,
  now: () => string,
): Promise<VerifyResult> {
  if (isDevMode()) {
    // Deterministic mock: a unique-human handle derived from the signal so the
    // anti-replay registry behaves realistically across runs in dev.
    return {
      ok: true,
      dev: true,
      approval: {
        action,
        signalHash: signal,
        nullifierHash: `dev_${sha256Hex({ action, signal, who: payload.nullifier_hash || 'dev-human' }).slice(0, 24)}`,
        merkleRoot: payload.merkle_root || 'dev-merkle',
        proof: payload.proof || 'dev-proof',
        verificationLevel: payload.verification_level || 'orb',
        verifiedAt: now(),
      },
    };
  }

  if (!worldConfig.appId) return { ok: false, error: 'World App ID not configured' };

  try {
    // Use the SDK's cloud verifier — it targets the correct endpoint for the app
    // (World ID 4.0 managed RP / v2), so we don't hand-roll the version-specific URL.
    const { verifyCloudProof } = (await import('@worldcoin/minikit-js')) as unknown as {
      verifyCloudProof: (
        payload: { proof: string; merkle_root: string; nullifier_hash: string; verification_level: 'orb' | 'device' },
        app_id: `app_${string}`,
        action: string,
        signal?: string,
      ) => Promise<{ success: boolean; code?: string; detail?: string }>;
    };
    const result = await verifyCloudProof(
      { proof: payload.proof, merkle_root: payload.merkle_root, nullifier_hash: payload.nullifier_hash, verification_level: payload.verification_level },
      worldConfig.appId as `app_${string}`,
      action,
      signal,
    );
    if (!result.success) return { ok: false, error: result.detail || result.code || 'World ID verification failed' };
    return {
      ok: true,
      approval: {
        action,
        signalHash: signal,
        nullifierHash: payload.nullifier_hash,
        merkleRoot: payload.merkle_root,
        proof: payload.proof,
        verificationLevel: payload.verification_level,
        verifiedAt: now(),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
