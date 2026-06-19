import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidAddress } from '../src/lib/chain/pay';
import { ReceiptBuilder } from '../src/lib/trust/receipt';
import { settleGovernedPayments } from '../src/lib/agent/run-mission';

const CHECKSUMMED = '0x6794ED2ddc3327FF0B1ee79EAfa8486193fAD856'; // canonical EIP-55 (verified)
const LOWER = '0x6794ed2ddc3327ff0b1ee79eafa8486193fad856';
const UPPER = '0x6794ED2DDC3327FF0B1EE79EAFA8486193FAD856';
const WRONG_CHECKSUM = '0x6794eD2ddc3327FF0B1ee79EAfa8486193fAD856'; // one nibble's case flipped

test('isValidAddress: all-lowercase is VALID (no checksum applied)', () => {
  assert.equal(isValidAddress(LOWER), true);
});
test('isValidAddress: all-uppercase is VALID', () => {
  assert.equal(isValidAddress(UPPER), true);
});
test('isValidAddress: correct mixed-case checksum is VALID', () => {
  assert.equal(isValidAddress(CHECKSUMMED), true);
});
test('isValidAddress: WRONG mixed-case checksum is INVALID', () => {
  assert.equal(isValidAddress(WRONG_CHECKSUM), false);
});
test('isValidAddress: bad format is INVALID', () => {
  assert.equal(isValidAddress('0x123'), false);
  assert.equal(isValidAddress('6794ed2ddc3327ff0b1ee79eafa8486193fad856'), false);
  assert.equal(isValidAddress('0xZZZ4ed2ddc3327ff0b1ee79eafa8486193fad856'), false);
});

const now = () => '2026-06-19T00:00:00.000Z';
const REAL_NULLIFIER = '0x' + 'a'.repeat(48);

function payChain(to: string) {
  const b = new ReceiptBuilder('m_test', 'ph', { worldIdNullifier: REAL_NULLIFIER });
  b.append('approve', now(), 'approved');
  b.append('execute_step', now(), 'pay', { stepId: 's1', tool: 'pay', ok: true, output: { status: 'authorized', awaitingSettlement: true, to, amountUsd: 0.1 } });
  return b.chain();
}

test('governance gate: WRONG-checksum recipient → payment WITHHELD (deterministic, not LLM)', async () => {
  const chain = payChain(WRONG_CHECKSUM);
  await settleGovernedPayments(chain, now);
  const blocked = chain.entries.find(e => e.kind === 'blocked' && (e.data as { reason?: string }).reason === 'recipient_invalid');
  const settled = chain.entries.find(e => e.kind === 'settle');
  assert.ok(blocked, 'expected withholding for invalid recipient');
  assert.equal(settled, undefined, 'must not settle to an invalid-checksum address');
});

test('governance gate: lowercase (valid) recipient does NOT trip the recipient-invalid gate', async () => {
  const chain = payChain(LOWER);
  await settleGovernedPayments(chain, now);
  const recipientBlock = chain.entries.find(e => e.kind === 'blocked' && (e.data as { reason?: string }).reason === 'recipient_invalid');
  assert.equal(recipientBlock, undefined, 'a valid all-lowercase address must not be blocked');
});
