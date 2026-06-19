import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicHttpUrl, htmlToText, fetchReadable, postWebhook } from '../src/lib/agent/fetch-tool';
import { gatherExecutedSteps, deterministicChecks, verdictSummary } from '../src/lib/agent/verifier';
import { ReceiptBuilder } from '../src/lib/trust/receipt';

const now = () => '2026-06-18T00:00:00.000Z';

// ── SSRF guard ──────────────────────────────────────────────────────────────
test('isPublicHttpUrl: allows public https', () => {
  assert.equal(isPublicHttpUrl('https://example.com/x').ok, true);
});
test('isPublicHttpUrl: blocks http, localhost, private, metadata, garbage', () => {
  for (const bad of [
    'http://example.com',            // not https
    'https://localhost/x',
    'https://127.0.0.1',
    'https://10.0.0.5',
    'https://192.168.1.1',
    'https://172.16.0.9',
    'https://169.254.169.254/latest', // cloud metadata
    'https://metadata.google.internal',
    'https://foo.internal',
    'not a url',
  ]) {
    assert.equal(isPublicHttpUrl(bad).ok, false, `${bad} must be blocked`);
  }
});
test('isPublicHttpUrl: allows public 172.x outside private range', () => {
  assert.equal(isPublicHttpUrl('https://172.15.0.1').ok, true);
  assert.equal(isPublicHttpUrl('https://172.32.0.1').ok, true);
});

test('htmlToText: extracts title + strips tags/scripts', () => {
  const { title, text } = htmlToText('<html><head><title> Hi There </title></head><body><script>x=1</script><p>Hello <b>world</b></p></body></html>');
  assert.equal(title, 'Hi There');
  assert.ok(text.includes('Hello world'));
  assert.ok(!text.includes('x=1'));
});

test('fetchReadable: blocked URL returns ok:false without calling fetch', async () => {
  let called = false;
  const r = await fetchReadable('https://localhost/secret', {}, (async () => { called = true; return new Response('x'); }) as typeof fetch);
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('fetchReadable: public URL parses html via injected fetch', async () => {
  const mock = (async () => new Response('<title>Doc</title><p>Body text here</p>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  const r = await fetchReadable('https://example.com', {}, mock);
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Doc');
  assert.ok(r.text!.includes('Body text here'));
});

test('postWebhook: blocked URL returns ok:false; public URL posts', async () => {
  assert.equal((await postWebhook('http://localhost/hook', { a: 1 })).ok, false);
  let body = '';
  const mock = (async (_u: string, init: RequestInit) => { body = String(init.body); return new Response('', { status: 202 }); }) as unknown as typeof fetch;
  const r = await postWebhook('https://hooks.example.com/x', { subject: 'hi' }, {}, mock);
  assert.equal(r.ok, true);
  assert.equal(r.status, 202);
  assert.ok(body.includes('hi'));
});

// ── Verifier ──────────────────────────────────────────────────────────────
function chainWithSteps() {
  const b = new ReceiptBuilder('m1', 'h1');
  b.append('plan', now(), 'planned');
  b.append('execute_step', now(), 'Executed: research', { stepId: 's1', tool: 'research', ok: true, outcome: 'brief', output: { brief: 'x' } });
  b.append('execute_step', now(), 'Failed: send', { stepId: 's2', tool: 'send', ok: false, outcome: 'err', output: {} });
  return b.chain();
}

test('gatherExecutedSteps: pulls only execute_step entries', () => {
  const steps = gatherExecutedSteps(chainWithSteps());
  assert.equal(steps.length, 2);
  assert.equal(steps[0]!.stepId, 's1');
  assert.equal(steps[0]!.ok, true);
  assert.equal(steps[1]!.ok, false);
});

test('deterministicChecks: a failed step is caught (no rubber-stamp)', () => {
  const r = deterministicChecks(gatherExecutedSteps(chainWithSteps()));
  assert.equal(r.pass, false);
  assert.ok(r.issues.length >= 1);
});

test('deterministicChecks: empty/no-substance output fails even if ok=true', () => {
  const r = deterministicChecks([{ stepId: 's1', tool: 'draft', ok: true, outcome: 'ok', output: { body: 'x' } }]);
  assert.equal(r.pass, false); // body too short → not substantive
  assert.ok(r.issues[0]!.includes('draft'));
});

test('deterministicChecks: substantive outputs pass; skipped steps ignored', () => {
  const r = deterministicChecks([
    { stepId: 's1', tool: 'research', ok: true, outcome: 'ok', output: { brief: 'a substantive research brief that is clearly long enough', sources: ['x'] } },
    { stepId: 's2', tool: 'compute', ok: false, outcome: 'skipped', output: { skipped: true } },
  ]);
  assert.equal(r.pass, true);
});

const baseVerdict = { gaps: [] as string[], perStep: [], deterministic: { pass: true, issues: [] }, lenses: [], model: true };
test('verdictSummary: reflects goalMet + confidence', () => {
  assert.match(verdictSummary({ ...baseVerdict, goalMet: true, confidence: 0.8, rationale: '' }), /goal met.*80%/);
  assert.match(verdictSummary({ ...baseVerdict, goalMet: false, confidence: 0.2, rationale: '' }), /NOT fully met/);
});
