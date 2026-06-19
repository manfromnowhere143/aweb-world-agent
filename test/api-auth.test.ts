import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, keysConfigured } from '../src/lib/api/auth';

const ORIG = process.env.WORLD_AGENT_API_KEYS;
afterEach(() => {
  if (ORIG === undefined) delete process.env.WORLD_AGENT_API_KEYS;
  else process.env.WORLD_AGENT_API_KEYS = ORIG;
});

function reqWith(auth?: string): Request {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = auth;
  return new Request('https://agent.aweblabs.ai/api/v1/missions', { method: 'POST', headers });
}

test('no keys configured → API open (full power, no read-only gate)', () => {
  delete process.env.WORLD_AGENT_API_KEYS;
  assert.equal(keysConfigured(), false);
  const caller = authenticate(reqWith());
  assert.ok(caller);
  assert.equal(caller!.authenticated, false);
  assert.equal(caller!.label, 'open');
});

test('keys configured + missing bearer → unauthorized (null)', () => {
  process.env.WORLD_AGENT_API_KEYS = 'partner:supersecretkey123';
  assert.equal(keysConfigured(), true);
  assert.equal(authenticate(reqWith()), null);
});

test('keys configured + valid bearer → authenticated with label', () => {
  process.env.WORLD_AGENT_API_KEYS = 'partner:supersecretkey123, other:zzz999';
  const caller = authenticate(reqWith('Bearer supersecretkey123'));
  assert.ok(caller);
  assert.equal(caller!.authenticated, true);
  assert.equal(caller!.label, 'partner');
});

test('keys configured + wrong bearer → null', () => {
  process.env.WORLD_AGENT_API_KEYS = 'partner:supersecretkey123';
  assert.equal(authenticate(reqWith('Bearer wrong')), null);
});

test('bare secret (no label) accepted under default label', () => {
  process.env.WORLD_AGENT_API_KEYS = 'justasecret';
  const caller = authenticate(reqWith('Bearer justasecret'));
  assert.ok(caller);
  assert.equal(caller!.authenticated, true);
});

test('x-api-key header is also accepted', () => {
  process.env.WORLD_AGENT_API_KEYS = 'p:sk_live_abc';
  const req = new Request('https://agent.aweblabs.ai/api/v1/missions', { method: 'POST', headers: { 'x-api-key': 'sk_live_abc' } });
  const caller = authenticate(req);
  assert.ok(caller);
  assert.equal(caller!.authenticated, true);
});
