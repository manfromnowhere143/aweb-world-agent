/**
 * Governance invariant tests for the Aweb Trust Runtime.
 * Run: node --import tsx --test test/trust.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GovernedMission, GovernanceError } from '../src/lib/trust/runtime';
import { verifyReceiptChain } from '../src/lib/trust/receipt';
import { InMemoryNullifierRegistry } from '../src/lib/trust/nullifier-registry';
import type { MissionPlan, PolicyConfig, WorldIdApproval } from '../src/lib/trust/types';

let clock = 0;
const now = () => `2026-06-17T00:00:${String(clock++).padStart(2, '0')}.000Z`;

function planWith(steps: MissionPlan['steps'], valueCapUsd = 100): MissionPlan {
  return { missionId: 'm_test', goal: 'test goal', createdAt: '2026-06-17T00:00:00.000Z', steps, dataBoundaries: ['public web'], valueCapUsd };
}
const POLICY: PolicyConfig = { allowedTools: ['research', 'draft', 'send', 'pay'], valueCapUsd: 100, autoApproveRiskClasses: ['READ_ONLY', 'REVERSIBLE'] };

const simOk = async (id: string) => ({ expected: `would run ${id}`, output: {} });
const execOk = async (id: string) => ({ stepId: id, ok: true, outcome: 'done', output: {}, costUsd: 0 });

test('read-only mission auto-approves and completes; receipt verifies', async () => {
  const m = new GovernedMission(planWith([
    { id: 's1', index: 0, tool: 'research', intent: 'research X', args: {}, riskClass: 'READ_ONLY' },
    { id: 's2', index: 1, tool: 'draft', intent: 'draft brief', args: {}, riskClass: 'REVERSIBLE' },
  ]), POLICY, { now });
  await m.simulate(simOk);
  assert.equal(m.state, 'approved'); // no sensitive steps
  await m.execute(execOk);
  assert.equal(m.state, 'completed');
  assert.equal(verifyReceiptChain(m.getReceipt()).valid, true);
});

test('sensitive step blocks execution until a valid World ID approval', async () => {
  const m = new GovernedMission(planWith([
    { id: 's1', index: 0, tool: 'research', intent: 'research', args: {}, riskClass: 'READ_ONLY' },
    { id: 's2', index: 1, tool: 'send', intent: 'send the message', args: {}, riskClass: 'SENSITIVE' },
  ]), POLICY, { now });
  await m.simulate(simOk);
  assert.equal(m.state, 'awaiting_approval');
  // executing before approval must fail
  await assert.rejects(() => m.execute(execOk), GovernanceError);
  const approval: WorldIdApproval = {
    action: 'approve-mission', signalHash: m.approvalSignal(), nullifierHash: 'null_a',
    merkleRoot: 'mr', proof: 'zk-proof-blob', verificationLevel: 'orb', verifiedAt: now(),
  };
  await m.approve(approval);
  assert.equal(m.state, 'approved');
  await m.execute(execOk);
  assert.equal(m.state, 'completed');
  const chain = m.getReceipt();
  assert.equal(verifyReceiptChain(chain).valid, true);
  // raw proof must be redacted in the receipt
  const approveEntry = chain.entries.find(e => e.kind === 'approve')!;
  assert.equal((approveEntry.data as any).proof, '[redacted]');
  assert.equal(chain.authority.worldIdNullifier, 'null_a');
});

test('approval bound to a different plan is rejected (hash mismatch)', async () => {
  const m = new GovernedMission(planWith([
    { id: 's1', index: 0, tool: 'send', intent: 'send', args: {}, riskClass: 'SENSITIVE' },
  ]), POLICY, { now });
  await m.simulate(simOk);
  await assert.rejects(() => m.approve({
    action: 'approve-mission', signalHash: 'WRONG_PLAN_HASH', nullifierHash: 'null_b',
    merkleRoot: 'mr', proof: 'p', verificationLevel: 'orb', verifiedAt: now(),
  }), GovernanceError);
});

test('anti-replay: same nullifier+signal cannot approve two identical-plan missions', async () => {
  const registry = new InMemoryNullifierRegistry();
  const steps: MissionPlan['steps'] = [{ id: 's1', index: 0, tool: 'send', intent: 'send', args: {}, riskClass: 'SENSITIVE' }];
  const m1 = new GovernedMission(planWith(steps), POLICY, { now, registry });
  await m1.simulate(simOk);
  const approval: WorldIdApproval = {
    action: 'approve-mission', signalHash: m1.approvalSignal(), nullifierHash: 'null_c',
    merkleRoot: 'mr', proof: 'p', verificationLevel: 'orb', verifiedAt: now(),
  };
  await m1.approve(approval);
  const m2 = new GovernedMission(planWith(steps), POLICY, { now, registry });
  await m2.simulate(simOk);
  assert.equal(m1.approvalSignal(), m2.approvalSignal()); // identical plans → identical signal
  await assert.rejects(() => m2.approve({ ...approval, signalHash: m2.approvalSignal() }), GovernanceError);
});

test('value over cap is denied at plan time (default-deny)', () => {
  assert.throws(() => new GovernedMission(planWith([
    { id: 's1', index: 0, tool: 'pay', intent: 'pay $500', args: {}, riskClass: 'VALUE_MOVEMENT', valueUsd: 500 },
  ], 100), POLICY, { now }), GovernanceError);
});

test('non-allowlisted tool is denied at plan time', () => {
  assert.throws(() => new GovernedMission(planWith([
    { id: 's1', index: 0, tool: 'rm_rf', intent: 'do something off-policy', args: {}, riskClass: 'REVERSIBLE' },
  ]), POLICY, { now }), GovernanceError);
});

test('value movement within cap still requires approval', async () => {
  const m = new GovernedMission(planWith([
    { id: 's1', index: 0, tool: 'pay', intent: 'pay $20', args: {}, riskClass: 'VALUE_MOVEMENT', valueUsd: 20 },
  ], 100), POLICY, { now });
  await m.simulate(simOk);
  assert.equal(m.state, 'awaiting_approval');
});

test('tampering with a receipt entry breaks the chain', async () => {
  const m = new GovernedMission(planWith([
    { id: 's1', index: 0, tool: 'research', intent: 'research', args: {}, riskClass: 'READ_ONLY' },
  ]), POLICY, { now });
  await m.simulate(simOk);
  await m.execute(execOk);
  const chain = m.getReceipt();
  assert.equal(verifyReceiptChain(chain).valid, true);
  (chain.entries[0]!.data as any).planHash = 'tampered';
  assert.equal(verifyReceiptChain(chain).valid, false);
});
