import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentCard } from '../src/lib/registry/agent-card';

const now = () => '2026-06-18T00:00:00.000Z';

test('agent card: standards-aligned, World-ID-bound, exposes endpoints + receipt standard', async () => {
  const card = await buildAgentCard({ total: 7, completed: 5, last7d: 7 }, now);
  assert.equal(card.name, 'Aweb Agent');
  assert.ok(card.standards.includes('ERC-8004'));
  assert.ok(card.standards.includes('EAS-execution-receipts'));
  assert.equal(card.identity.humansOnly, true);
  assert.equal(card.identity.proofOfPersonhood, 'world-id');
  assert.ok(card.trustModels.includes('world-id-approval'));
  assert.ok(card.trustModels.includes('onchain-anchor'));
  assert.ok(card.endpoints.mcp.endsWith('/api/mcp'));
  assert.ok(card.receiptStandard.schema.includes('/registry/receipt-schema'));
  assert.equal(card.receiptStandard.anchor.chainId, 480);
  assert.equal(card.reputation.total, 7);
  assert.ok(card.capabilities.length >= 5); // research/fetch/draft/compute/send/pay
  assert.ok(card.capabilities.some(c => c.name === 'pay' && c.riskClass === 'VALUE_MOVEMENT'));
});
