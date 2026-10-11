// Safety tiers for Google Play changes. Enforced by the server, not just by instructions.
//
//   Tier 3  BLOCKED   never executed by this plugin; no ticket is even issued
//   Tier 2  CONFIRM   preview, then a human "yes" (the apply tool prompts in Claude Code)
//   Tier 1  AUTO      small allowlist of low-risk edits (none yet: nearly everything on Play is live on commit)
//
// Anything not listed is Tier 2. A rule may only ever raise a tier, never lower one.

const BLOCKED = [
  {
    test: (m) => m.method === 'DELETE',
    reason: 'Deleting is blocked. Nothing in this plugin removes data from Google Play Console.',
  },
  {
    test: (m) => /^edits\.(commit|delete|insert|validate)$/.test(m.id),
    reason: 'Edits are opened, validated and committed by the plugin itself. Never change them directly.',
  },
  {
    test: (m) => /^(users|grants)\./.test(m.id),
    reason: 'Users and permissions are never changed by this plugin.',
  },
  {
    test: (m) => /^(orders|purchases|externaltransactions)\./.test(m.id) && m.method !== 'GET',
    reason: 'Refunds, cancellations and other actions on customer purchases are never changed by this plugin.',
  },
];

const TIER1 = []; // intentionally empty for now; add narrowly, with tests, as workflows need them

export function classify(method) {
  for (const b of BLOCKED) {
    if (b.test(method)) return { tier: 3, reason: b.reason };
  }
  for (const r of TIER1) {
    if (r.id === method.id) return { tier: 1, reason: r.reason };
  }
  if (method.id === 'reviews.reply') return { tier: 2, reason: 'a public reply, visible to everyone on Google Play' };
  if (method.id.startsWith('edits.listings.') || method.id.startsWith('edits.images.')) {
    return { tier: 2, reason: 'store listing content is public on Google Play as soon as it is committed' };
  }
  if (method.id.startsWith('edits.tracks.')) return { tier: 2, reason: 'a track change reaches testers or real users (most take effect as soon as they are committed)' };
  if (method.id.startsWith('monetization.')) return { tier: 2, reason: 'this affects subscriptions or what customers pay' };
  return { tier: 2, reason: 'changes to your Google Play app need your confirmation (most take effect as soon as they are committed)' };
}
