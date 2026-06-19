import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReceiptBuilder } from '../src/lib/trust/receipt';
import { sealReceipt } from '../src/lib/trust/signing';
import { attestReceipt } from '../src/lib/trust/verify-server';

const now = () => '2026-06-18T00:00:00.000Z';

function buildChain() {
  const b = new ReceiptBuilder('m_test', 'planhash_abc', { worldIdNullifier: '0xabc123' });
  b.append('plan', now(), 'planned');
  b.append('simulate', now(), 'simulated');
  b.append('execute_step', now(), 'researched', { output: { grounded: true } });
  return b.chain();
}

test('attest: intact + sealed chain → verified, integrity valid, authenticity valid', async () => {
  const chain = buildChain();
  chain.seal = (await sealReceipt(chain, now)) ?? undefined;
  const att = await attestReceipt(chain, now);
  assert.equal(att.integrity.valid, true);
  assert.equal(att.authenticity.status, 'valid');
  assert.equal(att.verified, true);
  assert.equal(att.anchor.present, false);
});

test('attest: tampered entry → integrity invalid, not verified', async () => {
  const chain = buildChain();
  chain.seal = (await sealReceipt(chain, now)) ?? undefined;
  chain.entries[1]!.summary = 'TAMPERED';
  const att = await attestReceipt(chain, now);
  assert.equal(att.integrity.valid, false);
  assert.equal(att.verified, false);
});

test('attest: forged seal (signature mismatch) → authenticity invalid', async () => {
  const chain = buildChain();
  const seal = (await sealReceipt(chain, now))!;
  // Flip the signature → must fail Ed25519 verification.
  const bytes = Buffer.from(seal.signature, 'base64');
  bytes[0] = bytes[0]! ^ 0xff;
  chain.seal = { ...seal, signature: bytes.toString('base64') };
  const att = await attestReceipt(chain, now);
  assert.equal(att.authenticity.status, 'invalid');
  assert.equal(att.verified, false);
});

test('attest: unsealed chain is still integrity-verified (seal optional)', async () => {
  const chain = buildChain();
  const att = await attestReceipt(chain, now);
  assert.equal(att.authenticity.status, 'unsealed');
  assert.equal(att.integrity.valid, true);
  assert.equal(att.verified, true);
});

test('attest: anchor present + bound to seal is reported (no on-chain read)', async () => {
  const chain = buildChain();
  chain.seal = (await sealReceipt(chain, now)) ?? undefined;
  chain.anchor = {
    chain: 'world-chain',
    chainId: 480,
    txHash: '0xdeadbeef',
    explorer: 'https://worldscan.org/tx/0xdeadbeef',
    rootHash: chain.seal!.signedHash,
    anchoredAt: now(),
  };
  const att = await attestReceipt(chain, now); // no verifyOnChain → no network
  assert.equal(att.anchor.present, true);
  if (att.anchor.present) {
    assert.equal(att.anchor.boundToSeal, true);
    assert.equal(att.anchor.chainId, 480);
    assert.equal(att.anchor.onChain, undefined);
  }
});
