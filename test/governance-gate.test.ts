import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReceiptBuilder } from '../src/lib/trust/receipt';
import { settleGovernedPayments } from '../src/lib/agent/run-mission';

const now = () => '2026-06-19T00:00:00.000Z';
const REAL_NULLIFIER = '0x' + 'a'.repeat(48); // passes isRealApproval (real-hex)

function chainWith(payAfterFailedPrereq: boolean) {
  const b = new ReceiptBuilder('m_test', 'planhash', { worldIdNullifier: REAL_NULLIFIER });
  b.append('plan', now(), 'planned');
  b.append('await_approval', now(), 'needs approval');
  b.append('approve', now(), 'approved');
  // prerequisite compute step — failed or succeeded depending on the case
  b.append('execute_step', now(), 'compute', { stepId: 's1', tool: 'compute', ok: !payAfterFailedPrereq, output: { exitCode: payAfterFailedPrereq ? 1 : 0 } });
  // value-movement step, authorized & awaiting settlement
  b.append('execute_step', now(), 'pay', { stepId: 's2', tool: 'pay', ok: true, output: { status: 'authorized', awaitingSettlement: true, to: '0x' + '1'.repeat(40), amountUsd: 0.1 } });
  return b.chain();
}

test('governance gate: payment is WITHHELD when a prerequisite step failed', async () => {
  const chain = chainWith(true);
  await settleGovernedPayments(chain, now);
  const blocked = chain.entries.find(e => e.kind === 'blocked' && (e.data as { reason?: string }).reason === 'prerequisite_step_failed');
  const settled = chain.entries.find(e => e.kind === 'settle');
  assert.ok(blocked, 'expected a blocked entry citing the failed prerequisite');
  assert.equal((blocked!.data as { withheld?: boolean }).withheld, true);
  assert.equal(settled, undefined, 'must NOT settle a payment when a prerequisite failed');
});

test('governance gate: no false-block when prerequisites succeeded (settle path proceeds to treasury)', async () => {
  const chain = chainWith(false);
  // No treasury key configured in test env → governedPay returns "not configured" and
  // records a normal blocked-for-config entry, NOT the prerequisite withholding. The
  // point: the prerequisite gate did NOT fire when prerequisites succeeded.
  await settleGovernedPayments(chain, now);
  const prereqBlock = chain.entries.find(e => e.kind === 'blocked' && (e.data as { reason?: string }).reason === 'prerequisite_step_failed');
  assert.equal(prereqBlock, undefined, 'prerequisite gate must not fire when prior steps succeeded');
});
