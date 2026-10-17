// Safety tiers for Google Cloud / Google Auth Platform changes. Enforced by the server.
//
//   Tier 3  BLOCKED   a switched-off feature, or a live project while "liveProjects" is off; no ticket is issued
//   Tier 2  CONFIRM   preview, then the owner's explicit "yes"
//   Tier 1  AUTO      none in v1 (every change is previewed and confirmed)
//
// A rule may only ever raise a tier, never lower one. The "destructive" feature is critical:
// it is Tier 2 but "sensitive", so it can only be applied with the separate sensitive tool.
import { ACTIONS } from './console.js';

export const LIVE_REASON = 'LIVE PROJECT: real users sign in with this';

export function classify(action, { projectId, live, features, params } = {}) {
  const def = ACTIONS[action];
  if (!def) {
    throw new Error(`Unknown action "${action}". Valid actions: ${Object.keys(ACTIONS).join(', ')}.`);
  }
  const feature = def.feature;
  const isLive = Boolean(live);
  const on = features || {};
  const base = { feature, live: isLive };

  if (!on[feature]) {
    return {
      tier: 3, ...base, sensitive: false,
      reason: `The "${feature}" feature is switched off in your settings, so this change is refused. Run /hypercaffium-google-oauth:setup to see or change your settings.`,
    };
  }
  if (isLive && !on.liveProjects) {
    return {
      tier: 3, ...base, sensitive: false,
      reason: `${LIVE_REASON}. Changes to live projects are switched off in your settings ("liveProjects"), so this change is refused${projectId ? ` for ${projectId}` : ''}.`,
    };
  }
  // Overwriting an existing client file is a hidden destructive step, so it needs the sensitive tool too.
  const overwrite = action === 'create_client' && params?.allowOverwrite === true;
  const sensitive = feature === 'destructive' || overwrite;
  let reason = overwrite
    ? 'critical: this will OVERWRITE the existing client file on disk, which cannot be undone'
    : sensitive
    ?'critical: this removes or resets sign-in setup and may be hard to undo'
    : 'changes to your Google sign-in setup need your confirmation';
  if (isLive) reason = `${LIVE_REASON}. ${reason}`;
  return { tier: 2, ...base, sensitive, reason };
}
