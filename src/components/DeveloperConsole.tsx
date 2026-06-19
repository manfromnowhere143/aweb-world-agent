'use client';
/**
 * Aweb Agent — Developer platform. One elegant, mobile-first surface that:
 *  • mints World-ID-scoped API keys (verify-human → session → key, shown once),
 *  • documents the governed REST API (curl / JS / Python),
 *  • and hands you a one-paste MCP server config.
 * Built entirely from the app's liquid-glass system — pixel-consistent with the
 * mission console. "World proves a human is behind the agent; Aweb proves it behaved."
 */
import { useEffect, useRef, useState } from 'react';
import { requestApproval, inWorldApp } from '@/lib/world/client';
import type { ApiKeyView } from '@/lib/store';

const VERIFY_ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION_VERIFY_HUMAN || 'verify-human';
const BASE = 'https://agent.aweblabs.ai';
const MCP_TOOLS = [
  'world_mission_create', 'world_mission_execute', 'world_mission_status',
  'world_receipt_get', 'world_receipt_verify', 'world_stats',
];

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`copy ${done ? 'done' : ''}`}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* ignore */ }
      }}
    >
      {done ? 'copied' : 'copy'}
    </button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="code">
      <Copy text={code} />
      <pre>{code}</pre>
    </div>
  );
}

export function DeveloperConsole() {
  const [stats, setStats] = useState<{ total: number; completed: number; last7d: number } | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [vlevel, setVlevel] = useState<string>('');
  const [dev, setDev] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [lang, setLang] = useState<'curl' | 'js' | 'python'>('curl');
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return; loaded.current = true;
    fetch('/api/v1').then(r => r.json()).then(d => setStats(d.stats)).catch(() => {});
  }, []);

  async function loadKeys(token: string) {
    const r = await fetch('/api/v1/keys', { headers: { 'x-wa-human-session': token } });
    const d = await r.json();
    if (r.ok) setKeys(d.keys || []);
  }

  async function verify() {
    setVerifying(true); setErr('');
    try {
      const proof = await requestApproval(VERIFY_ACTION, 'developer-console');
      const r = await fetch('/api/v1/human/session', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proof }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'verification failed');
      setSession(d.session); setVlevel(d.verificationLevel); setDev(!!d.dev);
      await loadKeys(d.session);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setVerifying(false); }
  }

  async function createKey() {
    if (!session) return;
    setCreating(true); setErr(''); setSecret(null);
    try {
      const r = await fetch('/api/v1/keys', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-wa-human-session': session },
        body: JSON.stringify({ name: name.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'could not create key');
      setSecret(d.secret); setName('');
      await loadKeys(session);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setCreating(false); }
  }

  async function revoke(id: string) {
    if (!session) return;
    const r = await fetch(`/api/v1/keys/${id}`, { method: 'DELETE', headers: { 'x-wa-human-session': session } });
    if (r.ok) await loadKeys(session);
  }

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const restExamples: Record<typeof lang, string> = {
    curl: `# 1 · Create a governed mission
MID=$(curl -s ${BASE}/api/v1/missions \\
  -H "Authorization: Bearer $AWEB_AGENT_KEY" \\
  -H "content-type: application/json" \\
  -d '{"goal":"Research 2026 stablecoin trends, summarize top 3"}' | jq -r .missionId)

# 2 · Execute → sealed + on-chain-anchored receipt
curl -s -X POST ${BASE}/api/v1/missions/$MID/execute \\
  -H "Authorization: Bearer $AWEB_AGENT_KEY" -d '{}'

# 3 · Verify the receipt (public, no key) — checks the anchor on World Chain
curl -s "${BASE}/api/v1/receipts/$MID/verify?onchain=1"`,
    js: `const KEY = process.env.AWEB_AGENT_KEY;
const h = { Authorization: \`Bearer \${KEY}\`, "content-type": "application/json" };

// 1 · create  2 · execute  3 · verify
const { missionId } = await (await fetch("${BASE}/api/v1/missions", {
  method: "POST", headers: h,
  body: JSON.stringify({ goal: "Research 2026 stablecoin trends, summarize top 3" }),
})).json();

const { receipt } = await (await fetch(\`${BASE}/api/v1/missions/\${missionId}/execute\`, {
  method: "POST", headers: h, body: "{}",
})).json();

const attestation = await (await fetch(
  \`${BASE}/api/v1/receipts/\${missionId}/verify?onchain=1\`)).json();
console.log(attestation.verified, attestation.anchor);`,
    python: `import os, requests
KEY = os.environ["AWEB_AGENT_KEY"]
h = {"Authorization": f"Bearer {KEY}", "content-type": "application/json"}
B = "${BASE}"

mid = requests.post(f"{B}/api/v1/missions", headers=h,
    json={"goal": "Research 2026 stablecoin trends, summarize top 3"}).json()["missionId"]

receipt = requests.post(f"{B}/api/v1/missions/{mid}/execute", headers=h, json={}).json()

att = requests.get(f"{B}/api/v1/receipts/{mid}/verify", params={"onchain": "1"}).json()
print(att["verified"], att["anchor"])`,
  };

  const mcpConfig = `{
  "mcpServers": {
    "aweb-world-agent": {
      "type": "streamable-http",
      "url": "${BASE}/api/mcp",
      "headers": {
        "Authorization": "Bearer sk-aweb-...",
        "MCP-Protocol-Version": "2025-06-18"
      }
    }
  }
}`;

  return (
    <div className="shell wide fade-in">
      <div className="topbar">
        <div className="brand"><div className="mark">A</div><div className="wordmark">Aweb&nbsp;Agent</div></div>
        <a className="backlink" href="/">← Open the agent</a>
      </div>
      <div className="kicker">Developer platform</div>
      <div className="gap" />

      <h1 className="title">Build on the trust layer.</h1>
      <p className="lede">
        Give any agent a verified-human identity and a <b>provable conscience</b>. Mint a key, call the governed
        API, connect the MCP server — every action returns a hash-chained, Ed25519-sealed, <b>on-chain-anchored</b>{' '}
        receipt anyone can verify.
      </p>

      <div className="gap" />
      <div className="navchips">
        <button className="navchip" onClick={() => jump('keys')}>API keys</button>
        <button className="navchip" onClick={() => jump('quickstart')}>Quickstart</button>
        <button className="navchip" onClick={() => jump('rest')}>REST API</button>
        <button className="navchip" onClick={() => jump('mcp')}>MCP server</button>
        <button className="navchip" onClick={() => jump('verify')}>Verify receipts</button>
      </div>

      <div className="gap" />
      <div className="glass tight pad">
        <div className="metrics">
          <div className="metric"><div className="mv">{stats ? stats.total : '—'}</div><div className="ml">Missions</div></div>
          <div className="metric"><div className="mv">{stats ? stats.completed : '—'}</div><div className="ml">Completed</div></div>
          <div className="metric"><div className="mv">{MCP_TOOLS.length}</div><div className="ml">MCP tools</div></div>
          <div className="metric"><div className="mv">480</div><div className="ml">World Chain</div></div>
        </div>
      </div>

      {/* ── API KEYS ─────────────────────────────────────────── */}
      <div className="sec" id="keys">
        <div className="sec-h">API keys</div>
        <div className="sec-d">
          Keys are <b>scoped to one verified human</b>. Prove you’re human once with World ID, then mint as many keys
          as you need — each is shown a single time and stored only as a hash.
        </div>

        {!session ? (
          <div className="glass pad verify-card">
            <p className="tl-detail" style={{ marginBottom: 14 }}>
              {inWorldApp() ? 'Verify with World ID to manage keys.' : 'Preview mode — verify to demo the full flow in any browser.'}
            </p>
            <button className="btn btn-world" disabled={verifying} onClick={verify}>
              {verifying ? <span className="spin" /> : 'Verify with World ID'}
            </button>
          </div>
        ) : (
          <>
            <div className="glass pad">
              <div className="row">
                <span className="faint" style={{ fontSize: 13 }}>Verified human</span>
                <span className="badge ok"><span className="dot" />{vlevel || 'orb'}{dev ? ' · preview' : ''}</span>
              </div>
              <div className="gap" />
              <input
                className="field" placeholder="Key name (e.g. my-agent, production)"
                value={name} maxLength={60} onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && name.trim().length >= 2) createKey(); }}
              />
              <div className="scopes">
                {['missions.create', 'missions.execute', 'receipts.read', 'mcp'].map(s => <span className="scope" key={s}>{s}</span>)}
              </div>
              <div className="gap-sm" />
              <button className="btn btn-primary" disabled={creating || name.trim().length < 2} onClick={createKey}>
                {creating ? <span className="spin" /> : 'Mint API key'}
              </button>
            </div>

            {secret && (
              <>
                <div className="gap" />
                <div className="secretbox">
                  <Copy text={secret} />
                  <div className="sk">{secret}</div>
                  <div className="secretwarn">⚠︎ Copy it now — this is the only time it’s shown. We store only a SHA-256 hash.</div>
                </div>
              </>
            )}

            {keys.length > 0 && (
              <>
                <div className="gap" />
                <div className="glass pad">
                  {keys.map(k => (
                    <div className="krow" key={k.id}>
                      <div style={{ minWidth: 0 }}>
                        <div className="kname">{k.name}{k.revokedAt && <span className="faint" style={{ fontWeight: 400 }}> · revoked</span>}</div>
                        <div className="kprefix">{k.keyPrefix}…</div>
                        <div className="kmeta">{k.usageCount} calls · created {new Date(k.createdAt).toLocaleDateString()}</div>
                      </div>
                      {!k.revokedAt && <button className="krevoke" onClick={() => revoke(k.id)}>Revoke</button>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        {err && <div className="glass tight pad" style={{ borderColor: 'rgba(255,138,122,0.4)', color: 'var(--red)', fontSize: 13, marginTop: 12 }}>{err}</div>}
      </div>

      {/* ── QUICKSTART ───────────────────────────────────────── */}
      <div className="sec" id="quickstart">
        <div className="sec-h">Quickstart</div>
        <div className="sec-d">Three calls: create a mission, execute it to a sealed receipt, and verify the receipt — including its World Chain anchor.</div>
        <CodeBlock code={restExamples.curl} />
      </div>

      {/* ── REST API ─────────────────────────────────────────── */}
      <div className="sec" id="rest">
        <div className="sec-h">REST API</div>
        <div className="sec-d">
          Base URL <span className="mono">{BASE}</span>. Authenticate writes with <span className="mono">Authorization: Bearer sk-aweb-…</span>.
          Receipt reads are public and CORS-open.
        </div>
        <div className="glass pad" style={{ marginBottom: 14 }}>
          <div className="ep"><span className="method post">POST</span><div><div className="path">/api/v1/missions</div><div className="epd">Create + plan a governed mission</div></div></div>
          <div className="ep"><span className="method post">POST</span><div><div className="path">/api/v1/missions/:id/execute</div><div className="epd">Execute → sealed + anchored receipt (World ID proof for sensitive steps)</div></div></div>
          <div className="ep"><span className="method get">GET</span><div><div className="path">/api/v1/missions/:id</div><div className="epd">Mission status + plan</div></div></div>
          <div className="ep"><span className="method get">GET</span><div><div className="path">/api/v1/receipts/:id</div><div className="epd">Full verifiable receipt + attestation · public</div></div></div>
          <div className="ep"><span className="method get">GET</span><div><div className="path">/api/v1/receipts/:id/verify?onchain=1</div><div className="epd">Attestation only — reads the anchor calldata on-chain · public</div></div></div>
          <div className="ep"><span className="method get">GET</span><div><div className="path">/api/v1/openapi.json</div><div className="epd">OpenAPI 3.1 specification</div></div></div>
        </div>
        <div className="tabs">
          {(['curl', 'js', 'python'] as const).map(l => (
            <button key={l} className={`tab ${lang === l ? 'on' : ''}`} onClick={() => setLang(l)}>
              {l === 'js' ? 'JavaScript' : l === 'python' ? 'Python' : 'cURL'}
            </button>
          ))}
        </div>
        <CodeBlock code={restExamples[lang]} />
      </div>

      {/* ── MCP SERVER ───────────────────────────────────────── */}
      <div className="sec" id="mcp">
        <div className="sec-h">MCP server</div>
        <div className="sec-d">
          Connect any MCP client (Claude, your own agent) over Streamable HTTP. Drop this into your MCP config and
          swap in a key — the same governed surface, callable by machines.
        </div>
        <CodeBlock code={mcpConfig} />
        <div className="gap-sm" />
        <div className="glass tight pad">
          <div className="faint" style={{ fontSize: 12, marginBottom: 10 }}>Tools ({MCP_TOOLS.length}) · protocol 2025-06-18</div>
          <div className="scopes">{MCP_TOOLS.map(t => <span className="scope" key={t}>{t}</span>)}</div>
        </div>
      </div>

      {/* ── VERIFY ───────────────────────────────────────────── */}
      <div className="sec" id="verify">
        <div className="sec-h">Verify receipts</div>
        <div className="sec-d">
          Every receipt is independently checkable — <b>integrity</b> (hash chain), <b>authenticity</b> (Ed25519 seal),
          and <b>anchor</b> (the sealed root committed on World Chain). With <span className="mono">?onchain=1</span> the
          API reads the tx calldata back and confirms it equals the root. Zero trust in us required.
        </div>
        <div className="glass tight pad">
          <div className="row"><span className="faint" style={{ fontSize: 13 }}>Integrity</span><span className="badge ok"><span className="dot" />hash chain</span></div>
          <div className="gap-sm" />
          <div className="row"><span className="faint" style={{ fontSize: 13 }}>Authenticity</span><span className="badge ok"><span className="dot" />Ed25519</span></div>
          <div className="gap-sm" />
          <div className="row"><span className="faint" style={{ fontSize: 13 }}>Anchor</span><span className="badge ok"><span className="dot" />World Chain</span></div>
        </div>
      </div>

      <div className="gap-lg" />
      <div className="center faint" style={{ fontSize: 12 }}>
        <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">OpenAPI</a> ·{' '}
        <a href="https://github.com/manfromnowhere143/aweb-world-agent" target="_blank" rel="noreferrer">Open source</a> ·{' '}
        World proves a human is behind the agent · Aweb proves it behaved
      </div>
      <div className="gap-lg" />
    </div>
  );
}
