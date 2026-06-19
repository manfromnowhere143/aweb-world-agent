/**
 * Sovereign REAL delivery — no mocks. The governed `send` step (which only runs
 * after a verified human approves the exact plan) actually delivers, auto-routing
 * by recipient shape, or honestly reports failure. Channels:
 *   email     → Resend            (recipient looks like an email)
 *   sms       → Twilio            (recipient is +E.164)
 *   telegram  → Telegram Bot API  (channel:'telegram' or tg:<chat_id>, default chat)
 *   webhook   → POST JSON         (https URL, SSRF-guarded)
 * An explicit `channel` arg overrides detection. If nothing can really deliver,
 * we return ok:false with a clear reason — never a fake success.
 */
import { isPublicHttpUrl, postWebhook } from './fetch-tool';

export interface DeliveryResult {
  ok: boolean;
  channel: string;
  to?: string;
  id?: string;
  status?: number | string;
  real: boolean;
  error?: string;
}

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const isPhone = (s: string) => /^\+[1-9]\d{6,14}$/.test(s.replace(/[\s()-]/g, ''));

export type Channel = 'email' | 'sms' | 'telegram' | 'webhook';

/** Decide the delivery channel from an explicit arg or the recipient's shape. */
export function detectChannel(to: string, explicit?: string): Channel | null {
  const c = (explicit || '').toLowerCase();
  if (c === 'email' || c === 'sms' || c === 'telegram' || c === 'webhook') return c as Channel;
  if (!to) return null;
  if (to.startsWith('tg:') || /^-?\d{5,}$/.test(to)) return 'telegram';
  if (/^https:\/\//i.test(to)) return 'webhook';
  if (isEmail(to)) return 'email';
  if (isPhone(to)) return 'sms';
  return null;
}

// The Aweb Agent's professional email identity (aweblabs.ai), mirroring Aweb's
// canonical signature: the agent's mark (favicon) left of the name, role line,
// the agent@aweblabs.ai address, and the live domain. data-aweb-signature marks
// it as the official Aweb presentation signature.
// The From MUST be the mailbox the OAuth refresh-token actually authorizes, or Gmail
// rejects/rewrites the send. GMAIL_SENDER is that authorized mailbox (e.g.
// dev@alfred-ai.app); AWEB_AGENT_FROM overrides only if it's a verified send-as alias.
const AGENT_FROM = process.env.AWEB_AGENT_FROM || process.env.GMAIL_SENDER || 'agent@aweblabs.ai';
const AGENT_NAME = 'Aweb Agent';
const AGENT_AVATAR = 'https://agent.aweblabs.ai/icon-512x512.png';
function agentSignatureHtml(): string {
  return [
    '<div data-aweb-signature="true" style="margin-top:28px;padding-top:16px;border-top:1px solid #111111;color:#111111;">',
    `<p style="margin:0 0 16px 0;color:#111111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;">Best,</p>`,
    '<table role="presentation" style="border-collapse:collapse;border-spacing:0;"><tr>',
    '<td valign="top" style="padding:0 14px 0 0;">',
    `<img data-aweb-signature-mark="true" src="${AGENT_AVATAR}" width="34" height="34" alt="Aweb Agent" style="display:block;width:34px;height:34px;border-radius:999px;border:1px solid #111111;background:#0b0d14;object-fit:cover;" />`,
    '</td><td valign="top" style="padding:0;">',
    `<p style="margin:0;color:#111111;font-family:'Iowan Old Style','Palatino Linotype',Georgia,serif;font-size:17px;line-height:1.2;font-weight:700;">${AGENT_NAME}</p>`,
    `<p style="margin:4px 0 0 0;color:#555;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:11px;line-height:1.4;letter-spacing:0.08em;text-transform:uppercase;">Governed agent · Aweb</p>`,
    `<p style="margin:10px 0 0 0;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;"><a href="mailto:${AGENT_FROM}" style="color:#111;text-decoration:none;">${AGENT_FROM}</a></p>`,
    `<p style="margin:2px 0 0 0;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#555;"><a href="https://agent.aweblabs.ai" style="color:#555;text-decoration:none;">agent.aweblabs.ai</a></p>`,
    '</td></tr></table></div>',
  ].join('');
}

// Email goes through Aweb's email engine — Google/Gmail (the canonical route),
// never Resend. Same OAuth refresh flow the MCP-warehouse Gmail adapter uses.
// The From presents the agent@aweblabs.ai identity (verified send-as if configured,
// else the verified route with Reply-To to the alias — the Aweb presentation pattern).
async function sendEmail(to: string, subject: string, body: string): Promise<DeliveryResult> {
  const cid = process.env.MCP_WAREHOUSE_GMAIL_CLIENT_ID || process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const csec = process.env.MCP_WAREHOUSE_GMAIL_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  const refresh = process.env.GMAIL_REFRESH_TOKEN;
  if (!cid || !csec || !refresh) return { ok: false, channel: 'email', to, real: false, error: 'gmail email engine not configured (client id/secret/refresh token)' };

  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: cid, client_secret: csec }).toString(),
  });
  const tj = await tr.json().catch(() => ({}));
  if (!tj.access_token) return { ok: false, channel: 'email', to, real: false, status: tr.status, error: `gmail auth refresh failed: ${tj.error_description || tj.error || tr.status}` };

  // Aweb Agent emails are clean + professional — strip emojis/pictographs entirely.
  const stripEmoji = (s: string) =>
    s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{2300}-\u{23FF}]/gu, '')
      .replace(/[ \t]{2,}/g, ' ').trim();
  const cleanSubject = stripEmoji(subject);
  const cleanBody = stripEmoji(body);

  const html = `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;line-height:1.6;color:#0b0d14;font-size:15px">${cleanBody.replace(/\n/g, '<br/>')}</div>${agentSignatureHtml()}`;
  // RFC-2047 encode any header still containing non-ASCII (e.g. accented names).
  const enc = (s: string) => (/[^\x00-\x7F]/.test(s) ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : s);
  const headers = [
    `From: ${AGENT_NAME} <${AGENT_FROM}>`,
    `Reply-To: ${AGENT_NAME} <${AGENT_FROM}>`,
    `To: ${to}`,
    `Subject: ${enc(cleanSubject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
  ].join('\r\n');
  const raw = Buffer.from(`${headers}\r\n\r\n${html}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${tj.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const sj = await sr.json().catch(() => ({}));
  if (!sr.ok) return { ok: false, channel: 'email', to, real: false, status: sr.status, error: sj?.error?.message || `gmail ${sr.status}` };
  return { ok: true, channel: 'email', to, id: sj.id, status: sr.status, real: true };
}

async function sendSMS(to: string, body: string): Promise<DeliveryResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER, svc = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!sid || !tok || !(from || svc)) return { ok: false, channel: 'sms', to, real: false, error: 'sms channel not configured' };
  const form = new URLSearchParams({ To: to, Body: body.slice(0, 1500) });
  if (svc) form.set('MessagingServiceSid', svc); else form.set('From', from!);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, channel: 'sms', to, real: false, status: res.status, error: j?.message || `twilio ${res.status}` };
  return { ok: true, channel: 'sms', to, id: j?.sid, status: j?.status, real: true };
}

async function sendTelegram(to: string, subject: string, body: string): Promise<DeliveryResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = (to && to !== 'telegram' ? to.replace(/^tg:/, '') : '') || process.env.TELEGRAM_DEFAULT_CHAT_ID || '';
  if (!token || !chat) return { ok: false, channel: 'telegram', to: chat, real: false, error: 'telegram channel not configured' };
  const text = subject ? `*${subject}*\n\n${body}` : body;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), parse_mode: 'Markdown' }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j?.ok) return { ok: false, channel: 'telegram', to: chat, real: false, status: res.status, error: j?.description || `telegram ${res.status}` };
  return { ok: true, channel: 'telegram', to: chat, id: String(j?.result?.message_id ?? ''), status: 'sent', real: true };
}

async function sendWebhook(url: string, subject: string, body: string, to?: string): Promise<DeliveryResult> {
  const check = isPublicHttpUrl(url);
  if (!check.ok) return { ok: false, channel: 'webhook', to: url, real: false, error: check.reason };
  const r = await postWebhook(url, { to: to ?? null, subject, body });
  if (!r.ok) return { ok: false, channel: 'webhook', to: url, real: false, status: r.status, error: r.error || `status ${r.status}` };
  return { ok: true, channel: 'webhook', to: url, status: r.status, real: true };
}

/** Deliver for real. `to` is the recipient (email/phone/chat/url). Never throws. */
export async function deliver(args: { to?: string; channel?: string; webhookUrl?: string; subject?: string; body?: string }): Promise<DeliveryResult> {
  const subject = String(args.subject ?? 'Message from your Aweb Agent');
  const body = String(args.body ?? '');
  // explicit webhookUrl always wins
  if (args.webhookUrl) return sendWebhook(String(args.webhookUrl), subject, body, args.to);
  const to = String(args.to ?? '').trim();
  const ch = detectChannel(to, args.channel);
  if (!ch) return { ok: false, channel: 'none', to, real: false, error: `could not determine a real delivery channel for "${to || '(empty)'}" — give an email, +phone, tg:<chat>, or https webhook` };
  try {
    switch (ch) {
      case 'email': return await sendEmail(to, subject, body);
      case 'sms': return await sendSMS(to, body ? `${subject}\n\n${body}` : subject);
      case 'telegram': return await sendTelegram(to, subject, body);
      case 'webhook': return await sendWebhook(to, subject, body);
    }
  } catch (e) {
    return { ok: false, channel: ch, to, real: false, error: e instanceof Error ? e.message : String(e) };
  }
}
