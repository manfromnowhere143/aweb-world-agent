/** Ed25519 receipt seal tests. Run via the package `test` script. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify as nodeVerify, createPublicKey } from 'node:crypto';
import { GovernedMission } from '../src/lib/trust/runtime';
import { sealReceipt } from '../src/lib/trust/signing';
import { appendToChain, verifyReceiptChain } from '../src/lib/trust/receipt';
import type { MissionPlan, PolicyConfig } from '../src/lib/trust/types';

let clock = 0;
const now = () => `2026-06-17T01:00:${String(clock++).padStart(2, '0')}.000Z`;
const POLICY: PolicyConfig = { allowedTools: ['research'], valueCapUsd: 0, autoApproveRiskClasses: ['READ_ONLY', 'REVERSIBLE'] };
const plan: MissionPlan = {
  missionId: 'm_seal', goal: 'seal test', createdAt: '2026-06-17T01:00:00.000Z',
  steps: [{ id: 's1', index: 0, tool: 'research', intent: 'research', args: {}, riskClass: 'READ_ONLY' }],
  dataBoundaries: ['public'], valueCapUsd: 0,
};

function verifySeal(signedHash: string, signatureB64: string, publicSpkiB64: string): boolean {
  const pub = createPublicKey({ key: Buffer.from(publicSpkiB64, 'base64'), format: 'der', type: 'spki' });
  return nodeVerify(null, Buffer.from(signedHash, 'utf8'), pub, Buffer.from(signatureB64, 'base64'));
}

test('a sealed receipt verifies with the published public key', async () => {
  const m = new GovernedMission(plan, POLICY, { now });
  await m.simulate(async () => ({ expected: 'x' }));
  await m.execute(async id => ({ stepId: id, ok: true, outcome: 'ok' }));
  const chain = m.getReceipt();
  const seal = await sealReceipt(chain, now);
  assert.ok(seal, 'seal produced');
  assert.equal(seal!.algorithm, 'Ed25519');
  assert.equal(seal!.signedHash, chain.entries[chain.entries.length - 1]!.hash);
  assert.equal(verifySeal(seal!.signedHash, seal!.signature, seal!.publicKey), true);
});

test('a forged/altered head fails seal verification', async () => {
  const m = new GovernedMission(plan, POLICY, { now });
  await m.simulate(async () => ({ expected: 'x' }));
  await m.execute(async id => ({ stepId: id, ok: true, outcome: 'ok' }));
  const seal = (await sealReceipt(m.getReceipt(), now))!;
  // attacker keeps the signature but swaps the signed content
  assert.equal(verifySeal(seal.signedHash + '00', seal.signature, seal.publicKey), false);
});

test('settlement appends a hash-chained entry and the re-sealed chain stays valid + authentic', async () => {
  const m = new GovernedMission(plan, POLICY, { now });
  await m.simulate(async () => ({ expected: 'x' }));
  await m.execute(async id => ({ stepId: id, ok: true, outcome: 'ok' }));
  const chain = m.getReceipt();
  chain.seal = (await sealReceipt(chain, now))!;
  const before = chain.entries.length;
  appendToChain(chain, 'settle', now(), 'Payment settled on-chain: 1 USDC', { txId: 'dev_tx_1', to: '0xabc' });
  assert.equal(chain.entries.length, before + 1);
  // chain integrity holds after append
  assert.equal(verifyReceiptChain(chain).valid, true);
  // re-seal over the new head and verify authenticity
  chain.seal = (await sealReceipt(chain, now))!;
  assert.equal(chain.seal.signedHash, chain.entries[chain.entries.length - 1]!.hash);
  assert.equal(verifySeal(chain.seal.signedHash, chain.seal.signature, chain.seal.publicKey), true);
});
