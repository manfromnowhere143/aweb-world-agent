/** World integration config + dev-mode detection. */
export const worldConfig = {
  appId: process.env.NEXT_PUBLIC_WORLD_APP_ID || '',
  rpId: process.env.WORLD_RP_ID || '', // World ID 4.0 managed relying-party id
  actionVerifyHuman: process.env.WORLD_ACTION_VERIFY_HUMAN || 'verify-human',
  actionApproveMission: process.env.WORLD_ACTION_APPROVE_MISSION || 'approve-mission',
  // Browser-preview sentinel approvals are OPT-IN only (secure-by-default): a real
  // production deployment NEVER accepts a fake "dev-human" proof unless an operator
  // explicitly sets WORLD_AGENT_ALLOW_PREVIEW=true (used only for the in-browser demo,
  // where every such approval is loudly marked dev:true / "preview" in the receipt).
  allowPreview: process.env.WORLD_AGENT_ALLOW_PREVIEW === 'true',
};

/** True when fake/preview proofs could be accepted alongside a real production App ID. */
export function previewWithRealApp(): boolean {
  return worldConfig.allowPreview && !isDevMode() && !!worldConfig.appId && !worldConfig.appId.includes('xxxx');
}

/**
 * Dev/mock mode: when explicitly enabled, or when no real App ID is configured,
 * World ID/wallet flows are simulated so the full governed loop is buildable and
 * testable outside World App. Never auto-on in production with a real App ID.
 */
export function isDevMode(): boolean {
  if (process.env.WORLD_AGENT_DEV_MODE === 'false') return false;
  if (process.env.WORLD_AGENT_DEV_MODE === 'true') return true;
  return !worldConfig.appId || worldConfig.appId.includes('xxxx');
}
