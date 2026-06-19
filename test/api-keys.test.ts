import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintKey, hashKey, KEY_PREFIX } from '../src/lib/api/keys';
import { issueHumanSession, verifyHumanSession } from '../src/lib/api/human-session';

test('mintKey: sk-aweb- prefix, hash matches, prefix is displayable + short', () => {
  const k = mintKey();
  assert.ok(k.secret.startsWith(KEY_PREFIX));
  assert.equal(k.hash, hashKey(k.secret));
  assert.ok(k.prefix.startsWith(KEY_PREFIX));
  assert.ok(k.prefix.length < k.secret.length);
  // hash never contains the secret
  assert.ok(!k.hash.includes(k.secret));
});

test('mintKey: every key is unique', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const k = mintKey();
    assert.ok(!seen.has(k.secret));
    seen.add(k.secret);
  }
});

test('hashKey: deterministic + 64-hex sha256', () => {
  assert.equal(hashKey('sk-aweb-abc'), hashKey('sk-aweb-abc'));
  assert.match(hashKey('sk-aweb-abc'), /^[0-9a-f]{64}$/);
  assert.notEqual(hashKey('a'), hashKey('b'));
});

const T0 = 1_750_000_000_000;

test('human session: issue → verify round-trips the nullifier', () => {
  const tok = issueHumanSession('0xhuman123', 'orb', T0);
  const s = verifyHumanSession(tok, T0 + 1000);
  assert.ok(s);
  assert.equal(s!.nullifier, '0xhuman123');
  assert.equal(s!.verificationLevel, 'orb');
});

test('human session: expired token rejected', () => {
  const tok = issueHumanSession('0xhuman123', 'orb', T0);
  assert.equal(verifyHumanSession(tok, T0 + 25 * 60 * 60 * 1000), null);
});

test('human session: tampered token rejected', () => {
  const tok = issueHumanSession('0xhuman123', 'orb', T0);
  const [body] = tok.split('.');
  // swap the payload but keep the old signature → must fail
  const forged = Buffer.from(JSON.stringify({ nullifier: '0xattacker', verificationLevel: 'orb', iat: T0, exp: T0 + 1e9 }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.' + tok.split('.')[1];
  assert.equal(verifyHumanSession(forged, T0 + 1000), null);
  assert.notEqual(body, undefined);
});

test('human session: garbage / empty rejected', () => {
  assert.equal(verifyHumanSession('', T0), null);
  assert.equal(verifyHumanSession('not-a-token', T0), null);
  assert.equal(verifyHumanSession(null, T0), null);
});
