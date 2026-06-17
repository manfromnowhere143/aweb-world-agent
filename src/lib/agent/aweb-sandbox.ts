/**
 * Aweb governed-sandbox client — lets the World agent run real code in Aweb's
 * E2B execution substrate (no-network, secret-forbid, autoKill, budget-capped)
 * and bring back a hash-chained sandbox + agent receipt as nested proof.
 *
 * This is how the agent stops merely *governing intent* and starts doing real,
 * provable work: World ID proves the human, Aweb's sandbox proves the code ran
 * in a governed box, and our own Ed25519 receipt chain seals the whole mission.
 *
 * DESIGN (sovereign + isolated):
 *   • The world-agent stays self-contained. This calls Aweb purely over HTTP —
 *     no workspace imports, nothing from Aweb core.
 *   • It GRACEFULLY DEGRADES: if no endpoint/token is configured, it returns
 *     { configured: false } and the caller treats the step as a clean skip. A
 *     missing backend never breaks the governed mission loop.
 *   • Trust stays local: the returned Aweb receipt is nested inside our own
 *     hash chain, so a compromised/offline Aweb degrades capability, never trust.
 *
 * NOTE on auth: Aweb's /api/aweb-code/preflight is currently SESSION-only, so a
 * headless caller needs a first-party, API-key-authenticated sandbox endpoint.
 * Point AWEB_SANDBOX_URL at that endpoint; it must accept the preflight request
 * shape ({ mode:'files', files, command }) and return the preflight response
 * shape ({ ok, sandbox:{exit_code,stdout,stderr,session_id}, sandbox_receipt,
 * agent_receipts }). Until then this degrades to a clean skip.
 */

const DEFAULT_PREFLIGHT_PATH = '/api/aweb-code/preflight';
const MAX_OUTPUT_CHARS = 8_000;

export interface AwebSandboxFile {
  path: string;
  content: string;
}

export interface AwebSandboxInput {
  files: AwebSandboxFile[];
  command: string;
  reason?: string;
  timeoutMs?: number;
}

export interface AwebSandboxResult {
  /** False when no endpoint/token is configured — caller degrades to a skip. */
  configured: boolean;
  /** True only when the sandbox ran and the command exited 0. */
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  sessionId?: string;
  durationMs?: number;
  /** Aweb sandbox_execution_receipt — nested into our receipt as proof. */
  sandboxReceipt?: unknown;
  /** Aweb agent_action_receipt — nested into our receipt as proof. */
  agentReceipt?: unknown;
  error?: string;
}

/**
 * Pure mapping from agent tool args to a governed preflight request. Supports a
 * single `code` blob (python/javascript/bash) or an explicit files+command
 * escape hatch. Files mode is no-network by design.
 */
export function buildComputeRequest(args: Record<string, unknown>): {
  files: AwebSandboxFile[];
  command: string;
} {
  const explicitFiles = args.files;
  const explicitCommand = args.command;
  if (
    Array.isArray(explicitFiles) &&
    explicitFiles.length > 0 &&
    typeof explicitCommand === 'string' &&
    explicitCommand.trim()
  ) {
    const files = explicitFiles
      .map(f => {
        const rec = f as Record<string, unknown>;
        return { path: String(rec.path ?? ''), content: String(rec.content ?? '') };
      })
      .filter(f => f.path);
    return { files, command: explicitCommand };
  }

  const code = String(args.code ?? '');
  const language = String(args.language ?? 'python').toLowerCase();

  if (language === 'bash' || language === 'sh') {
    return { files: [], command: code };
  }
  if (
    language === 'javascript' ||
    language === 'js' ||
    language === 'node' ||
    language === 'typescript' ||
    language === 'ts'
  ) {
    return { files: [{ path: 'main.mjs', content: code }], command: 'node main.mjs' };
  }
  // Default: python.
  return { files: [{ path: 'main.py', content: code }], command: 'python main.py' };
}

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}…[truncated ${value.length - MAX_OUTPUT_CHARS} chars]`;
}

function resolveEndpoint(): string | null {
  const direct = process.env.AWEB_SANDBOX_URL?.trim();
  if (direct) return direct;
  const base = process.env.AWEB_API_BASE?.trim();
  if (base) return `${base.replace(/\/+$/, '')}${DEFAULT_PREFLIGHT_PATH}`;
  return null;
}

interface PreflightResponse {
  ok?: boolean;
  duration_ms?: number;
  sandbox?: {
    exit_code?: number | null;
    stdout?: string;
    stderr?: string;
    session_id?: string;
  };
  sandbox_receipt?: unknown;
  agent_receipts?: unknown[];
  error?: string;
}

/**
 * Run a governed sandbox job against Aweb. Never throws — failures and missing
 * configuration come back as a typed result so the mission loop stays intact.
 * `fetchImpl` is injectable for tests.
 */
export async function runAwebSandbox(
  input: AwebSandboxInput,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<AwebSandboxResult> {
  const endpoint = resolveEndpoint();
  const token = (process.env.AWEB_SANDBOX_TOKEN || process.env.AWEB_API_KEY || '').trim();
  const miss: AwebSandboxResult = {
    configured: false,
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: '',
  };
  if (!endpoint || !token) {
    return { ...miss, error: 'Aweb sandbox not configured (set AWEB_SANDBOX_URL + AWEB_SANDBOX_TOKEN)' };
  }

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        mode: 'files',
        files: input.files,
        command: input.command,
        reason: input.reason ?? 'World agent governed sandbox run.',
        timeoutMs: input.timeoutMs ?? 60_000,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        configured: true,
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        error: `Aweb sandbox HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      };
    }

    const j = (await res.json()) as PreflightResponse;
    const exitCode = j.sandbox?.exit_code ?? null;
    return {
      configured: true,
      ok: j.ok === true || exitCode === 0,
      exitCode,
      stdout: truncate(j.sandbox?.stdout ?? ''),
      stderr: truncate(j.sandbox?.stderr ?? ''),
      sessionId: j.sandbox?.session_id,
      durationMs: j.duration_ms,
      sandboxReceipt: j.sandbox_receipt,
      agentReceipt: Array.isArray(j.agent_receipts) ? j.agent_receipts[0] : undefined,
    };
  } catch (e) {
    return {
      configured: true,
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
