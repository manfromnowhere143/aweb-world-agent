/**
 * Tests for the Aweb governed-sandbox compute tool: the pure request mapping,
 * the HTTP client (with an injected fetch — no network), and the end-to-end
 * governed mission proving (a) compute auto-runs as REVERSIBLE, (b) the Aweb
 * receipt is nested into our hash-chained receipt, and (c) a missing backend
 * degrades to a clean skip instead of breaking the mission.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildComputeRequest,
  runAwebSandbox,
  type AwebSandboxInput,
} from '../src/lib/agent/aweb-sandbox';
import { TOOL_SLUGS, toolBySlug, runTool, simulateTool } from '../src/lib/tools';
import { GovernedMission } from '../src/lib/trust/runtime';
import { verifyReceiptChain } from '../src/lib/trust/receipt';
import { policyFromPlan } from '../src/lib/agent/policy-from-plan';
import type { MissionPlan } from '../src/lib/trust/types';

// ── Pure request mapping ──────────────────────────────────────────────────
test('buildComputeRequest maps python/javascript/bash and an explicit escape hatch', () => {
  assert.deepEqual(buildComputeRequest({ code: 'print(1)' }), {
    files: [{ path: 'main.py', content: 'print(1)' }],
    command: 'python main.py',
  });
  assert.deepEqual(buildComputeRequest({ code: 'console.log(1)', language: 'javascript' }), {
    files: [{ path: 'main.mjs', content: 'console.log(1)' }],
    command: 'node main.mjs',
  });
  assert.deepEqual(buildComputeRequest({ code: 'echo hi', language: 'bash' }), {
    files: [],
    command: 'echo hi',
  });
  assert.deepEqual(
    buildComputeRequest({ files: [{ path: 'a.py', content: 'x=1' }], command: 'python a.py' }),
    { files: [{ path: 'a.py', content: 'x=1' }], command: 'python a.py' }
  );
});

// ── HTTP client (injected fetch, no network) ──────────────────────────────
const PREFLIGHT_OK = {
  ok: true,
  duration_ms: 2300,
  sandbox: { exit_code: 0, stdout: 'hello', stderr: '', session_id: 'sess_123' },
  sandbox_receipt: { object: 'sandbox_execution_receipt', receipt_hash: 'abc' },
  agent_receipts: [{ object: 'agent_action_receipt', receipt_hash: 'def' }],
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

const INPUT: AwebSandboxInput = { files: [{ path: 'main.py', content: 'print(1)' }], command: 'python main.py' };

test('runAwebSandbox: not configured → clean unconfigured result (no throw)', async () => {
  delete process.env.AWEB_SANDBOX_URL;
  delete process.env.AWEB_API_BASE;
  delete process.env.AWEB_SANDBOX_TOKEN;
  delete process.env.AWEB_API_KEY;
  const r = await runAwebSandbox(INPUT, fakeFetch(PREFLIGHT_OK));
  assert.equal(r.configured, false);
  assert.equal(r.ok, false);
});

test('runAwebSandbox: configured → parses output + extracts nested receipts', async () => {
  process.env.AWEB_SANDBOX_URL = 'https://aweblabs.ai/api/aweb-code/preflight';
  process.env.AWEB_SANDBOX_TOKEN = 'test-token';
  const r = await runAwebSandbox(INPUT, fakeFetch(PREFLIGHT_OK));
  assert.equal(r.configured, true);
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'hello');
  assert.equal(r.sessionId, 'sess_123');
  assert.deepEqual(r.sandboxReceipt, PREFLIGHT_OK.sandbox_receipt);
  assert.deepEqual(r.agentReceipt, PREFLIGHT_OK.agent_receipts[0]);
  delete process.env.AWEB_SANDBOX_URL;
  delete process.env.AWEB_SANDBOX_TOKEN;
});

test('runAwebSandbox: HTTP error → typed error, never throws', async () => {
  process.env.AWEB_SANDBOX_URL = 'https://aweblabs.ai/api/aweb-code/preflight';
  process.env.AWEB_SANDBOX_TOKEN = 'test-token';
  const r = await runAwebSandbox(INPUT, fakeFetch({ error: 'denied' }, 503));
  assert.equal(r.configured, true);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /HTTP 503/);
  delete process.env.AWEB_SANDBOX_URL;
  delete process.env.AWEB_SANDBOX_TOKEN;
});

// ── Tool registration ─────────────────────────────────────────────────────
test('compute is a registered REVERSIBLE tool (auto-runs, plannable)', () => {
  assert.ok(TOOL_SLUGS.includes('compute'));
  assert.equal(toolBySlug('compute')?.riskClass, 'REVERSIBLE');
});

test('simulateTool describes compute as a no-network sandbox run', async () => {
  const sim = await simulateTool('compute', { language: 'python' });
  assert.match(sim.expected, /sandbox/i);
});

test('runTool compute degrades to a clean skip when the backend is unconfigured', async () => {
  delete process.env.AWEB_SANDBOX_URL;
  delete process.env.AWEB_API_BASE;
  delete process.env.AWEB_SANDBOX_TOKEN;
  delete process.env.AWEB_API_KEY;
  const r = await runTool('compute', { code: 'print(1)' });
  assert.equal(r.ok, true); // a missing optional backend never fails the mission
  assert.equal(r.output?.skipped, true);
  assert.match(r.outcome, /not configured/i);
});

// ── End-to-end governed mission: compute auto-runs + receipt nests ─────────
test('governed mission: compute step auto-runs and nests the Aweb proof into our chain', async () => {
  let clock = 0;
  const now = () => `2026-06-17T02:00:${String(clock++).padStart(2, '0')}.000Z`;
  const plan: MissionPlan = {
    missionId: 'm_compute',
    goal: 'compute something',
    createdAt: '2026-06-17T02:00:00.000Z',
    steps: [
      {
        id: 's1',
        index: 0,
        tool: 'compute',
        intent: 'analyze the numbers',
        args: { code: 'print(sum(range(10)))', language: 'python' },
        riskClass: 'REVERSIBLE',
      },
    ],
    dataBoundaries: ['public'],
    valueCapUsd: 0,
  };

  const mission = new GovernedMission(plan, policyFromPlan(plan), { now });
  await mission.simulate(stepId => {
    const step = plan.steps.find(s => s.id === stepId)!;
    return simulateTool(step.tool, step.args);
  });
  // No sensitive steps → auto-approved without World ID.
  assert.equal(mission.state, 'approved');

  // Execute with the sandbox stubbed via an injected fetch through env+fetch.
  process.env.AWEB_SANDBOX_URL = 'https://aweblabs.ai/api/aweb-code/preflight';
  process.env.AWEB_SANDBOX_TOKEN = 'test-token';
  await mission.execute(async stepId => {
    const step = plan.steps.find(s => s.id === stepId)!;
    // Run the real tool, but route its sandbox call through a fake fetch by
    // temporarily swapping global fetch (the tool uses the default impl).
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(PREFLIGHT_OK);
    try {
      return { stepId, ...(await runTool(step.tool, step.args)) };
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  delete process.env.AWEB_SANDBOX_URL;
  delete process.env.AWEB_SANDBOX_TOKEN;

  assert.equal(mission.state, 'completed');
  const chain = mission.getReceipt();
  assert.equal(verifyReceiptChain(chain).valid, true);

  const exec = chain.entries.find(e => e.kind === 'execute_step');
  assert.ok(exec, 'execute_step entry exists');
  const output = exec!.data.output as Record<string, unknown>;
  assert.equal(output.exitCode, 0);
  assert.deepEqual(output.aweb_sandbox_receipt, PREFLIGHT_OK.sandbox_receipt);
  assert.deepEqual(output.aweb_agent_receipt, PREFLIGHT_OK.agent_receipts[0]);
});
