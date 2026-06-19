import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit } from '../src/lib/store';

const NOW = 1_750_000_000_000;

test('rate limit: allows up to the limit, blocks beyond', async () => {
  const id = `rl-allow-${NOW}`;
  const a = await rateLimit(id, 3, 60, NOW);
  const b = await rateLimit(id, 3, 60, NOW);
  const c = await rateLimit(id, 3, 60, NOW);
  const d = await rateLimit(id, 3, 60, NOW);
  assert.equal(a.ok, true);
  assert.equal(c.ok, true);
  assert.equal(d.ok, false);
  assert.ok(d.retryAfter > 0);
  assert.equal(a.remaining, 2);
});

test('rate limit: a new time window resets the counter', async () => {
  const id = 'rl-window';
  const w1 = NOW; // bucket N
  const w2 = NOW + 61_000; // bucket N+1
  assert.equal((await rateLimit(id, 1, 60, w1)).ok, true);
  assert.equal((await rateLimit(id, 1, 60, w1)).ok, false); // same window, over limit
  assert.equal((await rateLimit(id, 1, 60, w2)).ok, true); // next window, reset
});

test('rate limit: independent ids do not interfere', async () => {
  assert.equal((await rateLimit('rl-a', 1, 60, NOW)).ok, true);
  assert.equal((await rateLimit('rl-b', 1, 60, NOW)).ok, true);
});
