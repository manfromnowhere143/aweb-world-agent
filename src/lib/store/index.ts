/**
 * Pluggable store for missions, receipts, and used nullifiers.
 *
 * - Dev / local: file-backed JSON under data/.
 * - Production (serverless): Upstash Redis REST (set WA_KV_REST_URL + WA_KV_REST_TOKEN,
 *   or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). Required on Vercel, where
 *   the filesystem is ephemeral and not shared across invocations.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MissionPlan, ReceiptChain } from '../trust/types';
import type { NullifierRegistry } from '../trust/nullifier-registry';

const KV_URL = process.env.WA_KV_REST_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.WA_KV_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const useKv = !!(KV_URL && KV_TOKEN);
const NS = 'wa:'; // namespace so a shared KV stays isolated

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

// ---- file fallback (dev) ----
const DATA_DIR = path.join(process.cwd(), 'data');
const file = (n: string) => path.join(DATA_DIR, n);
async function readJson<T>(name: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file(name), 'utf8')) as T; } catch { return fallback; }
}
async function writeJson(name: string, value: unknown): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file(name), JSON.stringify(value, null, 2));
}

export interface StoredMission {
  missionId: string;
  plan: MissionPlan;
  planHash: string;
  receipt?: ReceiptChain;
  state: string;
  createdAt: string;
}

export async function saveMission(m: StoredMission): Promise<void> {
  if (useKv) { await redis(['SET', `${NS}mission:${m.missionId}`, JSON.stringify(m)]); return; }
  const all = await readJson<Record<string, StoredMission>>('missions.json', {});
  all[m.missionId] = m;
  await writeJson('missions.json', all);
}

export async function getMission(missionId: string): Promise<StoredMission | null> {
  if (useKv) {
    const raw = await redis<string | null>(['GET', `${NS}mission:${missionId}`]);
    return raw ? (JSON.parse(raw) as StoredMission) : null;
  }
  const all = await readJson<Record<string, StoredMission>>('missions.json', {});
  return all[missionId] ?? null;
}

/** Nullifier registry — KV-backed set in prod, file-backed list in dev. */
export class FileNullifierRegistry implements NullifierRegistry {
  private key(n: string, s: string) { return `${n}::${s}`; }
  async isUsed(nullifierHash: string, signalHash: string): Promise<boolean> {
    if (useKv) return (await redis<number>(['SISMEMBER', `${NS}nullifiers`, this.key(nullifierHash, signalHash)])) === 1;
    const used = await readJson<string[]>('nullifiers.json', []);
    return used.includes(this.key(nullifierHash, signalHash));
  }
  async markUsed(nullifierHash: string, signalHash: string): Promise<void> {
    if (useKv) { await redis(['SADD', `${NS}nullifiers`, this.key(nullifierHash, signalHash)]); return; }
    const used = await readJson<string[]>('nullifiers.json', []);
    const k = this.key(nullifierHash, signalHash);
    if (!used.includes(k)) { used.push(k); await writeJson('nullifiers.json', used); }
  }
}
