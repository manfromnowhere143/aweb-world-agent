/**
 * Durable store for missions, receipts, used nullifiers — enterprise-grade.
 *
 * Backend priority (auto-detected):
 *   1. Neon Postgres  (WA_DATABASE_URL)  — durable, queryable, usage analytics.
 *   2. Upstash Redis  (WA_KV_REST_URL/TOKEN) — serverless KV fallback.
 *   3. File JSON (dev/local only).
 *
 * The Neon path lazily ensures its schema, upserts missions, and exposes
 * `missionStats()` for grant metrics (totals, completed, last-7-day).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MissionPlan, ReceiptChain } from '../trust/types';
import type { NullifierRegistry } from '../trust/nullifier-registry';

const PG_URL = process.env.WA_DATABASE_URL;
const KV_URL = process.env.WA_KV_REST_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.WA_KV_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const backend: 'neon' | 'kv' | 'file' = PG_URL ? 'neon' : KV_URL && KV_TOKEN ? 'kv' : 'file';
const NS = 'wa:';

export interface StoredMission {
  missionId: string;
  plan: MissionPlan;
  planHash: string;
  receipt?: ReceiptChain;
  state: string;
  createdAt: string;
}

export interface StoredApiKey {
  id: string;
  keyHash: string;
  keyPrefix: string;
  name: string;
  humanNullifier: string; // the verified human (World ID) this key belongs to
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string;
  usageCount: number;
  revokedAt?: string;
}

/** Public view of a key (never includes the hash) for the developer console. */
export type ApiKeyView = Omit<StoredApiKey, 'keyHash' | 'humanNullifier'>;
export function toApiKeyView(k: StoredApiKey): ApiKeyView {
  const { keyHash: _h, humanNullifier: _n, ...view } = k;
  void _h; void _n;
  return view;
}

// ── Neon (Postgres) ─────────────────────────────────────────────────────────
type Sql = ReturnType<typeof import('@neondatabase/serverless').neon>;
let _sql: Sql | null = null;
let _schema: Promise<void> | null = null;
async function sql(): Promise<Sql> {
  if (!_sql) {
    const { neon } = await import('@neondatabase/serverless');
    _sql = neon(PG_URL as string);
  }
  if (!_schema) {
    const q = _sql;
    _schema = (async () => {
      await q`CREATE TABLE IF NOT EXISTS wa_missions (
        mission_id text PRIMARY KEY, plan jsonb NOT NULL, plan_hash text NOT NULL,
        receipt jsonb, state text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`;
      await q`CREATE TABLE IF NOT EXISTS wa_nullifiers (
        nullifier text NOT NULL, signal text NOT NULL, used_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (nullifier, signal))`;
      await q`CREATE TABLE IF NOT EXISTS wa_api_keys (
        id text PRIMARY KEY, key_hash text NOT NULL UNIQUE, key_prefix text NOT NULL,
        name text NOT NULL, human_nullifier text NOT NULL, scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz,
        usage_count integer NOT NULL DEFAULT 0, revoked_at timestamptz)`;
      await q`CREATE INDEX IF NOT EXISTS wa_api_keys_human ON wa_api_keys (human_nullifier)`;
      await q`CREATE TABLE IF NOT EXISTS wa_rate (k text PRIMARY KEY, count integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
      await q`CREATE TABLE IF NOT EXISTS wa_memory (
        id text PRIMARY KEY, subject text NOT NULL, mission_id text, summary text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now())`;
      await q`CREATE INDEX IF NOT EXISTS wa_memory_subject ON wa_memory (subject, created_at DESC)`;
    })();
  }
  await _schema;
  return _sql;
}

// ── Redis (KV) ──────────────────────────────────────────────────────────────
async function redis<T = unknown>(cmd: (string | number)[]): Promise<T> {
  const res = await fetch(KV_URL as string, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = (await res.json()) as { result?: T; error?: string };
  if (j.error) throw new Error(`kv: ${j.error}`);
  return j.result as T;
}

// ── File (dev) ──────────────────────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), 'data');
const file = (n: string) => path.join(DATA_DIR, n);
async function readJson<T>(name: string, fb: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file(name), 'utf8')) as T; } catch { return fb; }
}
async function writeJson(name: string, v: unknown): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file(name), JSON.stringify(v, null, 2));
}

// ── Public API ────────────────────────────────────────────────────────────
export async function saveMission(m: StoredMission): Promise<void> {
  if (backend === 'neon') {
    const q = await sql();
    await q`INSERT INTO wa_missions (mission_id, plan, plan_hash, receipt, state, created_at, updated_at)
      VALUES (${m.missionId}, ${JSON.stringify(m.plan)}::jsonb, ${m.planHash},
        ${m.receipt ? JSON.stringify(m.receipt) : null}::jsonb, ${m.state}, ${m.createdAt}, now())
      ON CONFLICT (mission_id) DO UPDATE SET
        plan = EXCLUDED.plan, plan_hash = EXCLUDED.plan_hash, receipt = EXCLUDED.receipt,
        state = EXCLUDED.state, updated_at = now()`;
    return;
  }
  if (backend === 'kv') { await redis(['SET', `${NS}mission:${m.missionId}`, JSON.stringify(m)]); return; }
  const all = await readJson<Record<string, StoredMission>>('missions.json', {});
  all[m.missionId] = m;
  await writeJson('missions.json', all);
}

export async function getMission(missionId: string): Promise<StoredMission | null> {
  if (backend === 'neon') {
    const q = await sql();
    const rows = (await q`SELECT mission_id, plan, plan_hash, receipt, state, created_at
      FROM wa_missions WHERE mission_id = ${missionId} LIMIT 1`) as Array<Record<string, unknown>>;
    if (!rows.length) return null;
    const r = rows[0]!;
    return {
      missionId: r.mission_id as string,
      plan: r.plan as MissionPlan,
      planHash: r.plan_hash as string,
      receipt: (r.receipt as ReceiptChain | null) ?? undefined,
      state: r.state as string,
      createdAt: new Date(r.created_at as string).toISOString(),
    };
  }
  if (backend === 'kv') {
    const raw = await redis<string | null>(['GET', `${NS}mission:${missionId}`]);
    return raw ? (JSON.parse(raw) as StoredMission) : null;
  }
  const all = await readJson<Record<string, StoredMission>>('missions.json', {});
  return all[missionId] ?? null;
}

/** Usage analytics for grant metrics. Neon-backed; best-effort elsewhere. */
export async function missionStats(): Promise<{ total: number; completed: number; last7d: number }> {
  if (backend === 'neon') {
    const q = await sql();
    const rows = (await q`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE state = 'completed')::int AS completed,
      count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS last7d
      FROM wa_missions`) as Array<{ total: number; completed: number; last7d: number }>;
    return rows[0] ?? { total: 0, completed: 0, last7d: 0 };
  }
  return { total: 0, completed: 0, last7d: 0 };
}

// ── Per-human memory (tri-backend, subject-scoped) ───────────────────────────
// The agent remembers each verified human across missions, keyed to a stable
// subject (World ID nullifier or wallet address) — the human's own data.
export interface MemoryEntry { id: string; subject: string; missionId?: string; summary: string; createdAt: string }

export async function saveMemory(subject: string, missionId: string, summary: string, nowIso: string): Promise<void> {
  if (!subject || !summary) return;
  const id = `mem_${missionId}_${subject.slice(-8)}`;
  if (backend === 'neon') {
    const q = await sql();
    await q`INSERT INTO wa_memory (id, subject, mission_id, summary, created_at) VALUES (${id}, ${subject}, ${missionId}, ${summary}, ${nowIso})
      ON CONFLICT (id) DO UPDATE SET summary = EXCLUDED.summary`;
    return;
  }
  if (backend === 'kv') {
    await redis(['LPUSH', `${NS}mem:${subject}`, JSON.stringify({ id, subject, missionId, summary, createdAt: nowIso })]);
    await redis(['LTRIM', `${NS}mem:${subject}`, 0, 49]); // keep most-recent 50
    return;
  }
  const all = await readJson<Record<string, MemoryEntry[]>>('memory.json', {});
  (all[subject] ||= []).unshift({ id, subject, missionId, summary, createdAt: nowIso });
  all[subject] = all[subject].slice(0, 50);
  await writeJson('memory.json', all);
}

/** Recall a human's most-recent memories (newest first). */
export async function recallMemory(subject: string, limit = 5): Promise<MemoryEntry[]> {
  if (!subject) return [];
  if (backend === 'neon') {
    const q = await sql();
    const rows = (await q`SELECT id, subject, mission_id, summary, created_at FROM wa_memory
      WHERE subject = ${subject} ORDER BY created_at DESC LIMIT ${limit}`) as Array<Record<string, unknown>>;
    return rows.map(r => ({ id: r.id as string, subject: r.subject as string, missionId: (r.mission_id as string) ?? undefined, summary: r.summary as string, createdAt: new Date(r.created_at as string).toISOString() }));
  }
  if (backend === 'kv') {
    const raw = (await redis<string[]>(['LRANGE', `${NS}mem:${subject}`, 0, limit - 1])) || [];
    return raw.map(s => JSON.parse(s) as MemoryEntry);
  }
  const all = await readJson<Record<string, MemoryEntry[]>>('memory.json', {});
  return (all[subject] ?? []).slice(0, limit);
}

// ── Rate limiting (tri-backend, fixed-window) ────────────────────────────────
const _rlMem = new Map<string, { count: number; exp: number }>();
export interface RateResult { ok: boolean; remaining: number; retryAfter: number }

/**
 * Fixed-window rate limit. `id` identifies the caller (api-key label / human
 * nullifier / client IP); `limit` requests per `windowSec`. Backend-aware
 * (Neon → KV → in-memory). `nowMs` injected by the caller (route layer).
 */
export async function rateLimit(id: string, limit: number, windowSec: number, nowMs: number): Promise<RateResult> {
  const bucket = Math.floor(nowMs / (windowSec * 1000));
  const k = `${id}:${bucket}`;
  let count = 1;
  try {
    if (backend === 'neon') {
      const q = await sql();
      const rows = (await q`INSERT INTO wa_rate (k, count) VALUES (${k}, 1)
        ON CONFLICT (k) DO UPDATE SET count = wa_rate.count + 1 RETURNING count`) as Array<{ count: number }>;
      count = Number(rows[0]?.count ?? 1);
      if (count === 1) { void q`DELETE FROM wa_rate WHERE created_at < now() - interval '1 hour'`.catch(() => {}); }
    } else if (backend === 'kv') {
      count = (await redis<number>(['INCR', `${NS}rl:${k}`])) || 1;
      if (count === 1) await redis(['EXPIRE', `${NS}rl:${k}`, windowSec * 2]);
    } else {
      const e = _rlMem.get(k);
      if (!e || e.exp < nowMs) { _rlMem.set(k, { count: 1, exp: nowMs + windowSec * 1000 }); count = 1; }
      else { e.count += 1; count = e.count; }
      if (_rlMem.size > 5000) for (const [mk, mv] of _rlMem) if (mv.exp < nowMs) _rlMem.delete(mk);
    }
  } catch {
    return { ok: true, remaining: limit, retryAfter: 0 }; // never block on limiter failure
  }
  const ok = count <= limit;
  return { ok, remaining: Math.max(0, limit - count), retryAfter: ok ? 0 : windowSec };
}

// ── API keys (tri-backend) ───────────────────────────────────────────────────
function kvKeyId(id: string) { return `${NS}apikey:${id}`; }
function kvKeyHashIdx(hash: string) { return `${NS}apikeyhash:${hash}`; }
function kvHumanKeys(nullifier: string) { return `${NS}humankeys:${nullifier}`; }

export async function createApiKey(k: StoredApiKey): Promise<void> {
  if (backend === 'neon') {
    const q = await sql();
    await q`INSERT INTO wa_api_keys (id, key_hash, key_prefix, name, human_nullifier, scopes, created_at, usage_count)
      VALUES (${k.id}, ${k.keyHash}, ${k.keyPrefix}, ${k.name}, ${k.humanNullifier},
        ${JSON.stringify(k.scopes)}::jsonb, ${k.createdAt}, ${k.usageCount})`;
    return;
  }
  if (backend === 'kv') {
    await redis(['SET', kvKeyId(k.id), JSON.stringify(k)]);
    await redis(['SET', kvKeyHashIdx(k.keyHash), k.id]);
    await redis(['SADD', kvHumanKeys(k.humanNullifier), k.id]);
    return;
  }
  const all = await readJson<Record<string, StoredApiKey>>('api-keys.json', {});
  all[k.id] = k;
  await writeJson('api-keys.json', all);
}

export async function listApiKeysByHuman(nullifier: string): Promise<StoredApiKey[]> {
  if (backend === 'neon') {
    const q = await sql();
    const rows = (await q`SELECT id, key_hash, key_prefix, name, human_nullifier, scopes, created_at, last_used_at, usage_count, revoked_at
      FROM wa_api_keys WHERE human_nullifier = ${nullifier} ORDER BY created_at DESC`) as Array<Record<string, unknown>>;
    return rows.map(rowToKey);
  }
  if (backend === 'kv') {
    const ids = (await redis<string[]>(['SMEMBERS', kvHumanKeys(nullifier)])) || [];
    const out: StoredApiKey[] = [];
    for (const id of ids) {
      const raw = await redis<string | null>(['GET', kvKeyId(id)]);
      if (raw) out.push(JSON.parse(raw) as StoredApiKey);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const all = await readJson<Record<string, StoredApiKey>>('api-keys.json', {});
  return Object.values(all).filter(k => k.humanNullifier === nullifier).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Look up an active key by its secret's hash; touches usage (best-effort). */
export async function findActiveApiKeyByHash(hash: string, nowIso: string): Promise<StoredApiKey | null> {
  if (backend === 'neon') {
    const q = await sql();
    const rows = (await q`SELECT id, key_hash, key_prefix, name, human_nullifier, scopes, created_at, last_used_at, usage_count, revoked_at
      FROM wa_api_keys WHERE key_hash = ${hash} AND revoked_at IS NULL LIMIT 1`) as Array<Record<string, unknown>>;
    if (!rows.length) return null;
    const key = rowToKey(rows[0]!);
    await q`UPDATE wa_api_keys SET usage_count = usage_count + 1, last_used_at = ${nowIso} WHERE id = ${key.id}`;
    return key;
  }
  if (backend === 'kv') {
    const id = await redis<string | null>(['GET', kvKeyHashIdx(hash)]);
    if (!id) return null;
    const raw = await redis<string | null>(['GET', kvKeyId(id)]);
    if (!raw) return null;
    const key = JSON.parse(raw) as StoredApiKey;
    if (key.revokedAt) return null;
    key.usageCount += 1; key.lastUsedAt = nowIso;
    await redis(['SET', kvKeyId(id), JSON.stringify(key)]);
    return key;
  }
  const all = await readJson<Record<string, StoredApiKey>>('api-keys.json', {});
  const key = Object.values(all).find(k => k.keyHash === hash && !k.revokedAt);
  if (!key) return null;
  key.usageCount += 1; key.lastUsedAt = nowIso;
  all[key.id] = key;
  await writeJson('api-keys.json', all);
  return key;
}

/** Revoke a key — only if it belongs to `nullifier`. Returns true if revoked. */
export async function revokeApiKey(id: string, nullifier: string, nowIso: string): Promise<boolean> {
  if (backend === 'neon') {
    const q = await sql();
    const rows = (await q`UPDATE wa_api_keys SET revoked_at = ${nowIso}
      WHERE id = ${id} AND human_nullifier = ${nullifier} AND revoked_at IS NULL RETURNING id`) as unknown[];
    return rows.length > 0;
  }
  if (backend === 'kv') {
    const raw = await redis<string | null>(['GET', kvKeyId(id)]);
    if (!raw) return false;
    const key = JSON.parse(raw) as StoredApiKey;
    if (key.humanNullifier !== nullifier || key.revokedAt) return false;
    key.revokedAt = nowIso;
    await redis(['SET', kvKeyId(id), JSON.stringify(key)]);
    return true;
  }
  const all = await readJson<Record<string, StoredApiKey>>('api-keys.json', {});
  const key = all[id];
  if (!key || key.humanNullifier !== nullifier || key.revokedAt) return false;
  key.revokedAt = nowIso;
  await writeJson('api-keys.json', all);
  return true;
}

function rowToKey(r: Record<string, unknown>): StoredApiKey {
  return {
    id: r.id as string,
    keyHash: r.key_hash as string,
    keyPrefix: r.key_prefix as string,
    name: r.name as string,
    humanNullifier: r.human_nullifier as string,
    scopes: (r.scopes as string[] | null) ?? [],
    createdAt: new Date(r.created_at as string).toISOString(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at as string).toISOString() : undefined,
    usageCount: Number(r.usage_count ?? 0),
    revokedAt: r.revoked_at ? new Date(r.revoked_at as string).toISOString() : undefined,
  };
}

/** Backend-aware single-use nullifier registry (Neon → KV → file). Anti-replay. */
export class FileNullifierRegistry implements NullifierRegistry {
  private key(n: string, s: string) { return `${n}::${s}`; }
  async isUsed(nullifierHash: string, signalHash: string): Promise<boolean> {
    if (backend === 'neon') {
      const q = await sql();
      const rows = (await q`SELECT 1 FROM wa_nullifiers WHERE nullifier = ${nullifierHash} AND signal = ${signalHash} LIMIT 1`) as unknown[];
      return rows.length > 0;
    }
    if (backend === 'kv') return (await redis<number>(['SISMEMBER', `${NS}nullifiers`, this.key(nullifierHash, signalHash)])) === 1;
    const used = await readJson<string[]>('nullifiers.json', []);
    return used.includes(this.key(nullifierHash, signalHash));
  }
  async markUsed(nullifierHash: string, signalHash: string): Promise<void> {
    if (backend === 'neon') {
      const q = await sql();
      await q`INSERT INTO wa_nullifiers (nullifier, signal) VALUES (${nullifierHash}, ${signalHash}) ON CONFLICT DO NOTHING`;
      return;
    }
    if (backend === 'kv') { await redis(['SADD', `${NS}nullifiers`, this.key(nullifierHash, signalHash)]); return; }
    const used = await readJson<string[]>('nullifiers.json', []);
    const k = this.key(nullifierHash, signalHash);
    if (!used.includes(k)) { used.push(k); await writeJson('nullifiers.json', used); }
  }
}
