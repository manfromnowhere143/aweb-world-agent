/**
 * Sovereign governed web tools — a real `fetch` (read a live public URL) and the
 * delivery primitive for a real `send` (POST to a public https webhook). Both go
 * through one SSRF guard: https only, no localhost / private / link-local / cloud
 * metadata hosts. No secrets, bounded body, hard timeout. Pure guard for testing.
 */

const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|::1|\[::1\])/i;
function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST.test(h)) return true;
  if (h === 'metadata.google.internal' || h.endsWith('.internal') || h.endsWith('.local')) return true;
  // 172.16.0.0 – 172.31.255.255
  const m = /^172\.(\d{1,3})\./.exec(h);
  if (m) { const o = Number(m[1]); if (o >= 16 && o <= 31) return true; }
  return false;
}

export interface UrlCheck { ok: boolean; url?: URL; reason?: string }

/** Pure: only public https URLs are allowed (blocks SSRF to internal targets). */
export function isPublicHttpUrl(raw: string): UrlCheck {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: 'invalid URL' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: 'only https:// URLs are allowed' };
  if (!url.hostname || isPrivateHostname(url.hostname)) return { ok: false, reason: 'host not allowed (private/internal)' };
  return { ok: true, url };
}

/** Strip HTML to readable-ish text + pull the <title>. Crude but dependency-free. */
export function htmlToText(html: string): { title?: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? titleMatch[1]!.replace(/\s+/g, ' ').trim() : undefined;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, text };
}

type FetchImpl = typeof fetch;

export interface FetchResult { ok: boolean; status?: number; title?: string; text?: string; url?: string; error?: string }

/** Fetch a public https URL and return its readable text + title. Never throws. */
export async function fetchReadable(
  rawUrl: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
  fetchImpl: FetchImpl = fetch,
): Promise<FetchResult> {
  const check = isPublicHttpUrl(rawUrl);
  if (!check.ok || !check.url) return { ok: false, error: check.reason };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 12_000);
  try {
    const res = await fetchImpl(check.url.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'AwebAgent/1.0 (+https://agent.aweblabs.ai)', accept: 'text/html,application/json,text/plain,*/*' },
      signal: controller.signal,
    });
    const raw = await res.text();
    const body = raw.slice(0, opts.maxBytes ?? 200_000);
    const ct = res.headers.get('content-type') || '';
    const parsed = ct.includes('html') ? htmlToText(body) : { text: body.replace(/\s+/g, ' ').trim() };
    return { ok: res.ok, status: res.status, title: parsed.title, text: parsed.text.slice(0, 6000), url: check.url.toString() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), url: check.url.toString() };
  } finally {
    clearTimeout(t);
  }
}

/** POST a JSON payload to a public https webhook (real delivery). Never throws. */
export async function postWebhook(
  rawUrl: string,
  payload: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
  fetchImpl: FetchImpl = fetch,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const check = isPublicHttpUrl(rawUrl);
  if (!check.ok || !check.url) return { ok: false, error: check.reason };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 12_000);
  try {
    const res = await fetchImpl(check.url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'AwebAgent/1.0 (+https://agent.aweblabs.ai)' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}
