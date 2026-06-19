/**
 * POST /api/v1/human/session — exchange a World ID (verify-human) proof for a
 * short-lived verified-human session token. The developer console uses that token
 * to mint / list / revoke API keys scoped to this one human — "one verified human,
 * one set of agent keys." Outside World App, dev-preview yields a stable handle so
 * the console is fully demoable in any browser.
 */
import { verifyWorldApproval, type WorldProofPayload } from '@/lib/world/verify';
import { worldConfig } from '@/lib/world/config';
import { issueHumanSession } from '@/lib/api/human-session';
import { json, apiError, preflight, rateGuard } from '@/lib/api/http';

export const runtime = 'nodejs';
const now = () => new Date().toISOString();
const SIGNAL = 'developer-console';

export function OPTIONS() {
  return preflight();
}

export async function POST(req: Request) {
  const limited = await rateGuard(req, 'session', 15); if (limited) return limited;
  const { proof } = (await req.json().catch(() => ({}))) as { proof?: WorldProofPayload };
  if (!proof) return apiError('World ID proof required', 400);

  const verified = await verifyWorldApproval(proof, worldConfig.actionVerifyHuman, SIGNAL, now);
  if (!verified.ok || !verified.approval) {
    return apiError(verified.error || 'World ID verification failed', 401);
  }
  const { nullifierHash, verificationLevel } = verified.approval;
  const session = issueHumanSession(nullifierHash, verificationLevel, Date.now());
  return json({ session, verificationLevel, dev: !!verified.dev });
}
