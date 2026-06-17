import { NextRequest, NextResponse } from 'next/server';
import { getMission, saveMission } from '@/lib/store';
import { appendToChain, verifyReceiptChain } from '@/lib/trust/receipt';
import { sealReceipt } from '@/lib/trust/signing';
import { verifyWorldTransaction } from '@/lib/world/verify';

export const runtime = 'nodejs';
const now = () => new Date().toISOString();

const WORLDCHAIN_EXPLORER = 'https://worldscan.org/tx/';

/**
 * Record the on-chain settlement of an authorized value movement: verify the
 * World Wallet transaction, append a hash-chained `settle` entry to the receipt,
 * and re-seal. The payment was authorized by the human's World ID approval of the
 * plan; this proves it actually settled.
 */
export async function POST(req: NextRequest) {
  try {
    const { missionId, stepId, txId, to, amountUsd, currency } = (await req.json()) as {
      missionId?: string; stepId?: string; txId?: string; to?: string; amountUsd?: number; currency?: string;
    };
    if (!missionId || !stepId || !txId) return NextResponse.json({ error: 'missionId, stepId, txId required' }, { status: 400 });

    const stored = await getMission(missionId);
    if (!stored?.receipt) return NextResponse.json({ error: 'mission/receipt not found' }, { status: 404 });

    const reference = `${missionId}:${stepId}`;
    const tx = await verifyWorldTransaction(txId, reference);
    if (!tx.ok) return NextResponse.json({ error: tx.error || 'transaction not verified' }, { status: 402 });

    const receipt = stored.receipt;
    appendToChain(receipt, 'settle', now(), `Payment settled on-chain: ${amountUsd ?? '?'} ${currency ?? ''} → ${to ?? 'payee'}`, {
      stepId, txId, status: tx.status ?? 'settled', to, amountUsd, currency,
      explorer: tx.dev ? null : `${WORLDCHAIN_EXPLORER}${txId}`,
      settledVia: 'world_wallet',
    });
    // Re-seal the extended chain so authenticity still holds.
    receipt.seal = (await sealReceipt(receipt, now)) ?? undefined;
    await saveMission({ ...stored, receipt });

    return NextResponse.json({ ok: true, txId, chainValid: verifyReceiptChain(receipt).valid, receipt });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
