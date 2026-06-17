/** World integration config + dev-mode detection. */
export const worldConfig = {
  appId: process.env.NEXT_PUBLIC_WORLD_APP_ID || '',
  rpId: process.env.WORLD_RP_ID || '', // World ID 4.0 managed relying-party id
  actionVerifyHuman: process.env.WORLD_ACTION_VERIFY_HUMAN || 'verify-human',
  actionApproveMission: process.env.WORLD_ACTION_APPROVE_MISSION || 'approve-mission',
};

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
