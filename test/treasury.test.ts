import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usdToCappedWei, isRealApproval } from '../src/lib/chain/pay';

test('usdToCappedWei: small amount is not capped', () => {
  const { wei, capped } = usdToCappedWei(0.1);
  assert.equal(capped, false);
  assert.ok(wei > 0n);
  assert.ok(wei < 300000000000000n); // under the default cap
});

test('usdToCappedWei: large amount clamps to the hard cap', () => {
  const { wei, capped } = usdToCappedWei(100000);
  assert.equal(capped, true);
  assert.equal(wei, 300000000000000n); // exactly the default cap
});

test('usdToCappedWei: zero/negative → zero', () => {
  assert.equal(usdToCappedWei(0).wei, 0n);
  assert.equal(usdToCappedWei(-5).wei, 0n);
});

test('isRealApproval: real World ID nullifier (long hex) is real', () => {
  assert.equal(isRealApproval('0x1a2b3c4d5e6f7a8b9c0d'), true);
});

test('isRealApproval: preview/dev sentinels are NOT real (no real money moves)', () => {
  assert.equal(isRealApproval('dev_abc123'), false);
  assert.equal(isRealApproval('dev-human'), false);
  assert.equal(isRealApproval(''), false);
  assert.equal(isRealApproval(undefined), false);
});
