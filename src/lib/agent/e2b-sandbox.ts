/**
 * Direct governed E2B sandbox — the World agent runs real code in an isolated,
 * ephemeral E2B micro-VM and brings back the output + a compact, hashed sandbox
 * proof that nests into our Ed25519 receipt chain.
 *
 * Sovereign by design: the agent runs the sandbox itself (E2B SDK + key), with no
 * dependency on any other backend. It GRACEFULLY DEGRADES — if E2B_API_KEY is
 * unset it returns { configured: false } and the caller treats the step as a
 * clean skip, so a missing key never breaks the governed mission loop.
 *
 * Governance: the sandbox is ephemeral and always killed (autoKill); compute is
 * classified REVERSIBLE (no external side effects on the user's accounts). The
 * sandbox proof records sandbox id, language, exit, duration, and SHA-256 of the
 * code + stdout — verifiable, leak-free evidence that this exact code ran.
 */
import { sha256Hex } from '../trust/hash';

const MAX_OUTPUT_CHARS = 8_000;

export interface SandboxProof {
  provider: 'e2b';
  sandboxId: string;
  language: string;
  exitCode: number | null;
  durationMs: number;
  codeSha256: string;
  stdoutSha256: string;
}

export interface E2BResult {
  configured: boolean;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  sandboxId?: string;
  durationMs?: number;
  sandboxProof?: SandboxProof;
  error?: string;
}

const truncate = (v: string) => (v.length <= MAX_OUTPUT_CHARS ? v : `${v.slice(0, MAX_OUTPUT_CHARS)}…[+${v.length - MAX_OUTPUT_CHARS} chars]`);

function normalizeLang(language: string): 'python' | 'js' | 'bash' {
  const l = language.toLowerCase();
  if (l === 'bash' || l === 'sh' || l === 'shell') return 'bash';
  if (l === 'javascript' || l === 'js' || l === 'node' || l === 'typescript' || l === 'ts') return 'js';
  return 'python';
}

/** Minimal sandbox surface — lets tests inject a fake without a live E2B call. */
export interface SandboxLike {
  sandboxId?: string;
  runCode(code: string, opts?: unknown): Promise<{ logs?: { stdout?: string[]; stderr?: string[] }; error?: { name: string; value: string } | null; text?: string }>;
  commands: { run(cmd: string, opts?: unknown): Promise<{ stdout?: string; stderr?: string; exitCode?: number }> };
  kill(): Promise<unknown>;
}
export type CreateSandbox = (opts: { apiKey: string; timeoutMs: number }) => Promise<SandboxLike>;

const defaultCreateSandbox: CreateSandbox = async opts => {
  const { Sandbox } = (await import('@e2b/code-interpreter')) as typeof import('@e2b/code-interpreter');
  return (await Sandbox.create(opts)) as unknown as SandboxLike;
};

// Deterministic crypto prelude prepended to every Python run. The E2B base image
// ships NO keccak (no pysha3/sha3/pycryptodome/eth_hash) and hashlib only has NIST
// SHA-3 — so agent code that needs Ethereum's keccak-256 (e.g. EIP-55) would crash.
// We inject a vetted, self-contained keccak-256 (verified against the canonical
// vectors keccak256("")=c5d2…a470 and keccak256("abc")=4e03…6c45) plus an eip55
// helper, so compute is correct OFFLINE with no third-party imports or network.
const PY_PRELUDE = `
def keccak_256(data):
    if isinstance(data, str): data = data.encode()
    _RC=[0x0000000000000001,0x0000000000008082,0x800000000000808A,0x8000000080008000,0x000000000000808B,0x0000000080000001,0x8000000080008081,0x8000000000008009,0x000000000000008A,0x0000000000000088,0x0000000080008009,0x000000008000000A,0x000000008000808B,0x800000000000008B,0x8000000000008089,0x8000000000008003,0x8000000000008002,0x8000000000000080,0x000000000000800A,0x800000008000000A,0x8000000080008081,0x8000000000008080,0x0000000080000001,0x8000000080008008]
    _R=[[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]]
    _M=0xFFFFFFFFFFFFFFFF
    def _rol(x,n): return ((x<<n)|(x>>(64-n)))&_M
    A=[[0]*5 for _ in range(5)]; rate=136
    m=bytearray(data); m.append(0x01)
    while len(m)%rate!=0: m.append(0x00)
    m[-1]^=0x80
    for off in range(0,len(m),rate):
        blk=m[off:off+rate]
        for i in range(rate//8): A[i%5][i//5]^=int.from_bytes(blk[i*8:i*8+8],'little')
        for rnd in range(24):
            C=[A[x][0]^A[x][1]^A[x][2]^A[x][3]^A[x][4] for x in range(5)]
            D=[C[(x-1)%5]^_rol(C[(x+1)%5],1) for x in range(5)]
            for x in range(5):
                for y in range(5): A[x][y]^=D[x]
            B=[[0]*5 for _ in range(5)]
            for x in range(5):
                for y in range(5): B[y][(2*x+3*y)%5]=_rol(A[x][y],_R[x][y])
            for x in range(5):
                for y in range(5): A[x][y]=B[x][y]^((~B[(x+1)%5][y])&B[(x+2)%5][y])
            A[0][0]^=_RC[rnd]
    out=bytearray()
    for i in range(4): out+=A[i%5][i//5].to_bytes(8,'little')
    return bytes(out[:32])

def eip55(addr):
    a=addr.lower().replace('0x',''); h=keccak_256(a.encode()).hex()
    return '0x'+''.join(c.upper() if c.isalpha() and int(h[i],16)>=8 else c for i,c in enumerate(a))
`;

/** Run code in a governed, ephemeral E2B sandbox. Never throws. `nowMs`/`createSandbox` injectable for tests. */
export async function runE2B(
  input: { code: string; language?: string; timeoutMs?: number },
  nowMs: () => number = () => Date.now(),
  createSandbox: CreateSandbox = defaultCreateSandbox,
): Promise<E2BResult> {
  const apiKey = process.env.E2B_API_KEY;
  const base: E2BResult = { configured: false, ok: false, exitCode: null, stdout: '', stderr: '' };
  if (!apiKey) return { ...base, error: 'E2B not configured (set E2B_API_KEY)' };
  if (!input.code?.trim()) return { ...base, configured: true, error: 'no code to run' };

  const lang = normalizeLang(input.language ?? 'python');
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 60_000, 5_000), 120_000);
  const start = nowMs();
  let sandbox: { kill: () => Promise<unknown> } | null = null;

  try {
    const sbx = await createSandbox({ apiKey, timeoutMs });
    sandbox = sbx;
    const sandboxId = sbx.sandboxId ?? 'e2b';

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = 0;

    if (lang === 'bash') {
      const r = await sbx.commands.run(input.code, { timeoutMs }).catch((e: unknown) => {
        const err = e as { stdout?: string; stderr?: string; exitCode?: number };
        return { stdout: err.stdout ?? '', stderr: err.stderr ?? String((e as Error)?.message ?? e), exitCode: err.exitCode ?? 1 };
      });
      stdout = r.stdout ?? '';
      stderr = r.stderr ?? '';
      exitCode = typeof r.exitCode === 'number' ? r.exitCode : 0;
    } else {
      // Python gets the vetted keccak/eip55 prelude so offline crypto never crashes.
      const codeToRun = lang === 'js' ? input.code : `${PY_PRELUDE}\n${input.code}`;
      const exec = await sbx.runCode(codeToRun, { language: lang === 'js' ? 'js' : 'python', timeoutMs } as never);
      stdout = (exec.logs?.stdout ?? []).join('');
      stderr = (exec.logs?.stderr ?? []).join('');
      if (exec.error) {
        stderr = `${stderr}${exec.error.name}: ${exec.error.value}`.trim();
        exitCode = 1;
      }
      // include the last expression's text result if there was no printed stdout
      if (!stdout && exec.text) stdout = exec.text;
    }

    const durationMs = nowMs() - start;
    const proof: SandboxProof = {
      provider: 'e2b',
      sandboxId,
      language: lang,
      exitCode,
      durationMs,
      codeSha256: sha256Hex(input.code),
      stdoutSha256: sha256Hex(stdout),
    };
    return {
      configured: true,
      ok: exitCode === 0,
      exitCode,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
      sandboxId,
      durationMs,
      sandboxProof: proof,
    };
  } catch (e) {
    return { ...base, configured: true, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (sandbox) await sandbox.kill().catch(() => {});
  }
}
