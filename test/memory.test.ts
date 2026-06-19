import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveMemory, recallMemory } from '../src/lib/store';

test('memory: save then recall, newest-first, scoped to the subject', async () => {
  const subj = `subj-${Date.now()}-${Math.floor(performance.now())}`;
  await saveMemory(subj, 'm1', 'first mission summary', '2026-06-18T00:00:00.000Z');
  await saveMemory(subj, 'm2', 'second mission summary', '2026-06-18T00:01:00.000Z');
  const recalled = await recallMemory(subj, 5);
  assert.ok(recalled.length >= 2);
  assert.equal(recalled[0]!.summary, 'second mission summary'); // newest first
  assert.ok(recalled.every(m => m.subject === subj));
});

test('memory: subjects are isolated from each other', async () => {
  const a = `A-${Date.now()}`, b = `B-${Date.now()}`;
  await saveMemory(a, 'ma', 'alpha note', '2026-06-18T00:00:00.000Z');
  await saveMemory(b, 'mb', 'beta note', '2026-06-18T00:00:00.000Z');
  const ra = await recallMemory(a, 5);
  assert.ok(ra.some(m => m.summary === 'alpha note'));
  assert.ok(ra.every(m => m.summary !== 'beta note'));
});

test('memory: empty subject is a no-op / returns nothing', async () => {
  assert.deepEqual(await recallMemory('', 5), []);
  await saveMemory('', 'x', 'should not store', '2026-06-18T00:00:00.000Z'); // must not throw
});
