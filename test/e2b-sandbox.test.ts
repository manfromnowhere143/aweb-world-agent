/**
 * Tests for the direct governed E2B compute tool: the runner (with an injected
 * fake sandbox — no live call), the tool registration, the clean skip when no key
 * is configured, and the end-to-end governed mission invariant (compute auto-runs
 * REVERSIBLE and a missing backend degrades to a clean skip without breaking the
 * sealed receipt chain).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runE2B, type CreateSandbox } from '../src/lib/agent/e2b-sandbox';
import { TOOL_SLUGS, toolBySlug, runTool, simulateTool } from '../src/lib/tools';
import { GovernedMission } from '../src/lib/trust/runtime';
import { verifyReceiptChain } from '../src/lib/trust/receipt';
import { policyFromPlan } from '../src/lib/agent/policy-from-plan';
import type { MissionPlan } from '../src/lib/trust/types';

let nowCtr = 0;
const nowMs = () => 1_000 * ++nowCtr;

/** Fake sandbox: python via runCode logs, bash via commands.run. */
function fakeSandbox(opts: { stdout?: string[]; bashStdout?: string; bashExit?: number; runError?: { name: string; value: string } } = {}): CreateSandbox {
  return async () => ({
    sandboxId: 'sbx_fake_123',
    async runCode() {
      return { logs: { stdout: opts.stdout ?? ['42\n'], stderr: [] }, error: opts.runError ?? null };
    },
    commands: { async run() { return { stdout: opts.bashStdout ?? 'hi\n', stderr: '', exitCode: opts.bashExit ?? 0 }; } },
    async kill() { return undefined; },
  });
}

test('runE2B: python run → ok, stdout, and a hashed sandbox proof', async () => {
  process.env.E2B_API_KEY = 'test-key';
  const r = await runE2B({ code: 'print(6*7)', language: 'python' }, nowMs, fakeSandbox({ stdout: ['42\n'] }));
  assert.equal(r.configured, true);
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), '42');
  assert.equal(r.sandboxProof?.provider, 'e2b');
  assert.equal(r.sandboxProof?.sandboxId, 'sbx_fake_123');
  assert.equal((r.sandboxProof?.codeSha256 ?? '').length, 64);
  assert.equal((r.sandboxProof?.stdoutSha256 ?? '').length, 64);
});

test('runE2B: bash via commands.run', async () => {
  process.env.E2B_API_KEY = 'test-key';
  const r = await runE2B({ code: 'echo hi', language: 'bash' }, nowMs, fakeSandbox({ bashStdout: 'hi\n', bashExit: 0 }));
  assert.equal(r.ok, true);
  assert.equal(r.stdout.trim(), 'hi');
});

test('runE2B: runtime error → ok:false, exit 1', async () => {
  process.env.E2B_API_KEY = 'test-key';
  const r = await runE2B({ code: 'boom', language: 'python' }, nowMs, fakeSandbox({ stdout: [], runError: { name: 'NameError', value: 'boom is not defined' } }));
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /NameError/);
});

test('runE2B: no key → clean unconfigured result (never throws)', async () => {
  delete process.env.E2B_API_KEY;
  const r = await runE2B({ code: 'print(1)' });
  assert.equal(r.configured, false);
  assert.equal(r.ok, false);
});

test('compute is a registered REVERSIBLE tool (auto-runs, plannable)', () => {
  assert.ok(TOOL_SLUGS.includes('compute'));
  assert.equal(toolBySlug('compute')?.riskClass, 'REVERSIBLE');
});

test('simulateTool describes compute as a sandbox run', async () => {
  const sim = await simulateTool('compute', { language: 'python' });
  assert.match(sim.expected, /sandbox/i);
});

test('runTool compute degrades to a clean skip when E2B is unconfigured', async () => {
  delete process.env.E2B_API_KEY;
  const r = await runTool('compute', { code: 'print(1)' });
  assert.equal(r.ok, true); // a missing optional backend never fails the mission
  assert.equal(r.output?.skipped, true);
  assert.match(r.outcome, /not configured/i);
});

test('governed mission: compute auto-runs REVERSIBLE and a missing backend still seals cleanly', async () => {
  delete process.env.E2B_API_KEY; // force the clean-skip path — deterministic, no live call
  let clock = 0;
  const now = () => `2026-06-18T00:00:${String(clock++).padStart(2, '0')}.000Z`;
  const plan: MissionPlan = {
    missionId: 'm_compute',
    goal: 'compute something',
    createdAt: '2026-06-18T00:00:00.000Z',
    steps: [{ id: 's1', index: 0, tool: 'compute', intent: 'analyze the numbers', args: { code: 'print(sum(range(10)))', language: 'python' }, riskClass: 'REVERSIBLE' }],
    dataBoundaries: ['public'],
    valueCapUsd: 0,
  };
  const mission = new GovernedMission(plan, policyFromPlan(plan), { now });
  await mission.simulate(stepId => simulateTool(plan.steps.find(s => s.id === stepId)!.tool, plan.steps.find(s => s.id === stepId)!.args));
  assert.equal(mission.state, 'approved'); // no sensitive steps → auto-approved
  await mission.execute(async stepId => {
    const step = plan.steps.find(s => s.id === stepId)!;
    return { stepId, ...(await runTool(step.tool, step.args)) };
  });
  assert.equal(mission.state, 'completed');
  assert.equal(verifyReceiptChain(mission.getReceipt()).valid, true);
});
