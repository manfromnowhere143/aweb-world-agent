/**
 * World Chain receipt anchoring — stamps a sealed receipt's root hash on-chain as
 * a permanent, publicly-verifiable proof (worldscan.org). A 0-value self-transfer
 * carries the 32-byte root in calldata, signed by a dedicated server signer.
 *
 * Sovereign + graceful: if WORLD_CHAIN_SIGNER_KEY is unset or unfunded, anchoring
 * cleanly skips — the mission and its sealed receipt are unaffected. Trust never
 * depends on the chain being reachable.
 */
import type { Hex } from 'viem';
import type { ReceiptAnchor, ReceiptSeal } from '@/lib/trust/types';

const NET = (process.env.WORLD_CHAIN_NETWORK || 'mainnet').toLowerCase();

export interface AnchorResult {
  anchored: boolean;
  txHash?: string;
  explorer?: string;
  chainId?: number;
  from?: string;
  rootHash?: string;
  error?: string;
}

/** Public address of the configured signer (no key exposure), for funding/status. */
export async function anchorSignerAddress(): Promise<string | null> {
  const pk = process.env.WORLD_CHAIN_SIGNER_KEY;
  if (!pk) return null;
  const { privateKeyToAccount } = await import('viem/accounts');
  return privateKeyToAccount(pk as Hex).address;
}

export async function chainConfig() {
  const { worldchain, worldchainSepolia } = await import('viem/chains');
  const chain = NET === 'sepolia' ? worldchainSepolia : worldchain;
  // Only trust a well-formed Alchemy key (real keys are ~32 chars); otherwise fall
  // back to the public World Chain RPC, which serves balance + tx-send reliably.
  const alchemy = process.env.ALCHEMY_API_KEY;
  const rpc = alchemy && alchemy.length >= 30
    ? `https://worldchain-${NET === 'sepolia' ? 'sepolia' : 'mainnet'}.g.alchemy.com/v2/${alchemy}`
    : chain.rpcUrls.default.http[0];
  const explorerBase = NET === 'sepolia' ? 'https://worldchain-sepolia.explorer.alchemy.com/tx/' : 'https://worldscan.org/tx/';
  return { chain, rpc, explorerBase };
}

/** Current signer balance in wei (string), or null if no signer configured. */
export async function anchorSignerBalance(): Promise<{ address: string; wei: string; eth: string } | null> {
  const pk = process.env.WORLD_CHAIN_SIGNER_KEY;
  if (!pk) return null;
  const { createPublicClient, http, formatEther } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { chain, rpc } = await chainConfig();
  const account = privateKeyToAccount(pk as Hex);
  const client = createPublicClient({ chain, transport: http(rpc) });
  const wei = await client.getBalance({ address: account.address });
  return { address: account.address, wei: wei.toString(), eth: formatEther(wei) };
}

/**
 * Anchor a receipt root hash (hex, no 0x) on World Chain. Never throws.
 * @param now ISO timestamp provider (injected — no Date in shared logic).
 */
export async function anchorReceiptRoot(rootHashHex: string, now: () => string): Promise<AnchorResult & { anchoredAt?: string }> {
  const pk = process.env.WORLD_CHAIN_SIGNER_KEY;
  if (!pk) return { anchored: false, error: 'no signer configured' };
  try {
    const { createWalletClient, createPublicClient, http } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { chain, rpc, explorerBase } = await chainConfig();
    const account = privateKeyToAccount(pk as Hex);

    // Skip cleanly if the signer is unfunded — never break the mission for gas.
    const pub = createPublicClient({ chain, transport: http(rpc) });
    const balance = await pub.getBalance({ address: account.address });
    if (balance === 0n) return { anchored: false, from: account.address, error: 'signer unfunded' };

    const wallet = createWalletClient({ account, chain, transport: http(rpc) });
    const data = `0x${rootHashHex.replace(/^0x/, '')}` as Hex; // 32-byte receipt root as calldata
    const txHash = await wallet.sendTransaction({ to: account.address, value: 0n, data });
    return {
      anchored: true,
      txHash,
      explorer: `${explorerBase}${txHash}`,
      chainId: chain.id,
      from: account.address,
      rootHash: rootHashHex,
      anchoredAt: now(),
    };
  } catch (e) {
    return { anchored: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Anchor a sealed receipt's chain-head hash on World Chain and return a typed
 * ReceiptAnchor, or null if anchoring was skipped (no signer / unfunded) or failed.
 * Never throws — anchoring is a best-effort permanence layer over the sealed receipt.
 */
export async function anchorSealedReceipt(
  seal: ReceiptSeal | undefined,
  now: () => string,
): Promise<ReceiptAnchor | null> {
  if (!seal?.signedHash) return null;
  const a = await anchorReceiptRoot(seal.signedHash, now);
  if (!a.anchored || !a.txHash || !a.chainId || !a.explorer || !a.rootHash || !a.anchoredAt) return null;
  return {
    chain: 'world-chain',
    chainId: a.chainId,
    txHash: a.txHash,
    explorer: a.explorer,
    rootHash: a.rootHash,
    anchoredAt: a.anchoredAt,
  };
}
