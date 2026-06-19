/**
 * Server-side receipt verification — the authoritative attestation behind the
 * public Receipts API. Mirrors the in-browser verifier (verify-web.ts) so the
 * API's verdict and the user's own device agree, and additionally proves the
 * on-chain anchor by reading the committed calldata back from World Chain.
 *
 * Three independent checks, each defensible on its own:
 *   integrity    — recompute every hash + linkage (tamper-evidence)
 *   authenticity — Ed25519-verify the seal over the chain head (non-repudiation)
 *   anchor       — the sealed root is committed on-chain, calldata === root
 */
import { verify as nodeVerify, createPublicKey } from 'node:crypto';
import { verifyReceiptChain } from './receipt';
import type { ReceiptChain } from './types';

export interface ReceiptAttestation {
  missionId: string;
  verified: boolean; // integrity ∧ authenticity (anchor is additive, not required)
  integrity: { valid: boolean; brokenAt?: number; reason?: string };
  authenticity: { status: 'valid' | 'invalid' | 'unsealed'; reason?: string };
  anchor:
    | { present: false }
    | {
        present: true;
        chain: 'world-chain';
        chainId: number;
        txHash: string;
        explorer: string;
        rootHash: string;
        boundToSeal: boolean; // anchor.rootHash === seal.signedHash
        onChain?: { checked: boolean; calldataMatches?: boolean; blockNumber?: number; error?: string };
      };
  checkedAt: string;
}

/** Ed25519-verify the seal over the chain head using node:crypto (server path). */
function verifySeal(chain: ReceiptChain): { status: 'valid' | 'invalid' | 'unsealed'; reason?: string } {
  const seal = chain.seal;
  if (!seal) return { status: 'unsealed' };
  const head = chain.entries.length ? chain.entries[chain.entries.length - 1]!.hash : '';
  if (seal.signedHash !== head) return { status: 'invalid', reason: 'sealed hash ≠ chain head' };
  try {
    const key = createPublicKey({ key: Buffer.from(seal.publicKey, 'base64'), format: 'der', type: 'spki' });
    const ok = nodeVerify(null, Buffer.from(seal.signedHash, 'utf8'), key, Buffer.from(seal.signature, 'base64'));
    return ok ? { status: 'valid' } : { status: 'invalid', reason: 'signature does not verify' };
  } catch (e) {
    return { status: 'invalid', reason: e instanceof Error ? e.message : 'verify error' };
  }
}

/**
 * Build the full attestation for a receipt. `verifyOnChain` additionally reads
 * the anchor tx calldata from World Chain and checks it equals the sealed root —
 * the strongest, trustless proof. Network failures degrade gracefully (the
 * off-chain integrity + authenticity verdict is never blocked by RPC).
 */
export async function attestReceipt(
  chain: ReceiptChain,
  now: () => string,
  opts: { verifyOnChain?: boolean } = {},
): Promise<ReceiptAttestation> {
  const integrity = verifyReceiptChain(chain);
  const authenticity = verifySeal(chain);

  let anchor: ReceiptAttestation['anchor'] = { present: false };
  if (chain.anchor) {
    const a = chain.anchor;
    const boundToSeal = !!chain.seal && chain.seal.signedHash === a.rootHash;
    const onChain = opts.verifyOnChain ? await verifyAnchorOnChain(a.txHash, a.rootHash) : undefined;
    anchor = {
      present: true,
      chain: a.chain,
      chainId: a.chainId,
      txHash: a.txHash,
      explorer: a.explorer,
      rootHash: a.rootHash,
      boundToSeal,
      ...(onChain ? { onChain } : {}),
    };
  }

  const verified = integrity.valid && (authenticity.status === 'valid' || authenticity.status === 'unsealed');
  return { missionId: chain.missionId, verified, integrity, authenticity, anchor, checkedAt: now() };
}

/** Read the anchor tx calldata from World Chain and confirm it equals the root. */
async function verifyAnchorOnChain(
  txHash: string,
  rootHash: string,
): Promise<{ checked: boolean; calldataMatches?: boolean; blockNumber?: number; error?: string }> {
  try {
    const { createPublicClient, http } = await import('viem');
    const { worldchain, worldchainSepolia } = await import('viem/chains');
    const net = (process.env.WORLD_CHAIN_NETWORK || 'mainnet').toLowerCase();
    const chain = net === 'sepolia' ? worldchainSepolia : worldchain;
    const alchemy = process.env.ALCHEMY_API_KEY;
    const rpc =
      alchemy && alchemy.length >= 30
        ? `https://worldchain-${net === 'sepolia' ? 'sepolia' : 'mainnet'}.g.alchemy.com/v2/${alchemy}`
        : chain.rpcUrls.default.http[0];
    const client = createPublicClient({ chain, transport: http(rpc) });
    const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
    const expected = `0x${rootHash.replace(/^0x/, '')}`.toLowerCase();
    return {
      checked: true,
      calldataMatches: (tx.input || '').toLowerCase() === expected,
      blockNumber: tx.blockNumber != null ? Number(tx.blockNumber) : undefined,
    };
  } catch (e) {
    return { checked: false, error: e instanceof Error ? e.message : String(e) };
  }
}
