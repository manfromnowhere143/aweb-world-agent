import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../src/lib/agent/anthropic';

// Regression: the planner asks the model to put runnable CODE (full of { } and [])
// into args.code. A non-string-aware boundary scanner miscounts those braces and
// throws "unbalanced JSON". extractJson must ignore braces inside string values.
test('extractJson: braces/brackets inside string values do not break the scan', () => {
  const code = 'def f():\n    return {"a": 1, "b": {"c": [2, 3]}}\nprint(f())';
  const obj = { steps: [{ tool: 'compute', args: { code, language: 'python' } }] };
  const wrapped = 'Here is the plan:\n```json\n' + JSON.stringify(obj) + '\n```';
  const parsed = extractJson<typeof obj>(wrapped);
  assert.equal(parsed.steps[0]!.args.code, code);
});

test('extractJson: escaped quotes inside strings are handled', () => {
  const obj = { intent: 'say \\"hi\\" and { compute }', n: 1 };
  const parsed = extractJson<{ intent: string; n: number }>(JSON.stringify(obj));
  assert.equal(parsed.n, 1);
});

test('extractJson: plain nested object', () => {
  const parsed = extractJson<{ a: { b: number } }>('noise {"a":{"b":5}} trailing');
  assert.equal(parsed.a.b, 5);
});

test('extractJson: truncated JSON throws a clear error', () => {
  assert.throws(() => extractJson('{"a": "unterminated value and no close'), /unbalanced|truncated/i);
});
