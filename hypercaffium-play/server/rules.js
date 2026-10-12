// Safety tiers for Google Play changes. Enforced by the server, not just by instructions.
//
//   Tier 3  BLOCKED   never executed by this plugin; no ticket is even issued
//   Tier 2  CONFIRM   preview, then a human "yes" (the apply tool prompts in Claude Code)
//   Tier 1  AUTO      small allowlist of low-risk edits (none yet: nearly everything on Play is live on commit)
//
// Anything not listed is Tier 2. A rule may only ever raise a tier, never lower one.
//
// On top of the tiers, every change belongs to a FEATURE (see shared/features.js). A switched-off
// feature is Tier 3 for every route. Critical features (users, signing, refunds) are "sensitive":
// they can only be applied with play_apply_sensitive_change, a separate tool with its own prompt.
import { isCritical, resolveFeatures } from '../../shared/features.js';

let featureSource = () => ({});
// index.js points this at the settings file; tests can point it at anything.
export function setFeatureSource(fn) {
  featureSource = fn;
}
export const currentFeatures = () => resolveFeatures(featureSource(), 'play');

const FEATURE_BY_METHOD = [
  ['users', /^(users|grants)\./],
  ['refunds', /^(orders|purchases|externaltransactions)\./],
  ['signing', /^appsigning\./],
  ['uploads', /^(edits\.(apks|bundles|deobfuscationfiles|expansionfiles)\.|internalappsharingartifacts\.|appstoreappsreview\.upload)/],
  ['listing', /^(edits\.(listings|images|details)\.|applications\.dataSafety$)/],
  ['testing', /^edits\.testers\./],
  ['releases', /^edits\.tracks\./],
  ['reviews', /^reviews\./],
  ['pricing', /^(inappproducts|monetization)\./],
];

// Which feature a method belongs to. Unknown areas are "advanced".
export function featureFor(methodId) {
  for (const [feature, re] of FEATURE_BY_METHOD) if (re.test(methodId)) return feature;
  return 'advanced';
}

const BLOCKED = [
  {
    test: (m) => m.method === 'DELETE',
    reason: 'Deleting is blocked. Nothing in this plugin removes data from Google Play Console.',
  },
  {
    test: (m) => /^edits\.(commit|delete|insert|validate)$/.test(m.id),
    reason: 'Edits are opened, validated and committed by the plugin itself. Never change them directly.',
  },
];

const CRITICAL_DELETES = new Set(['users.delete', 'grants.delete']);

const TIER1 = []; // intentionally empty for now; add narrowly, with tests, as workflows need them

export function classify(method) {
  const feature = featureFor(method.id);
  if (!currentFeatures()[feature]) {
    return {
      tier: 3,
      feature,
      reason: `The "${feature}" feature is switched off in your settings, so this change is refused. Run /hypercaffium-play:setup to see or change your settings.`,
    };
  }
  // The only deletes outside an edit: removing a team member or one app's access, when "users" is on.
  if (CRITICAL_DELETES.has(method.id)) return { tier: 2, feature, sensitive: true, reason: criticalReason(feature) };
  for (const b of BLOCKED) {
    if (b.test(method)) return { tier: 3, feature, reason: b.reason };
  }
  if (isCritical(feature)) return { tier: 2, feature, sensitive: true, reason: criticalReason(feature) };
  for (const r of TIER1) {
    if (r.id === method.id) return { tier: 1, feature, reason: r.reason };
  }
  return { tier: 2, feature, reason: tier2Reason(method.id) };
}

function criticalReason(feature) {
  if (feature === 'users') return 'critical: this changes who can access your Google Play developer account';
  if (feature === 'refunds') return 'critical: this acts on a customer\'s money or subscription';
  return 'critical: this changes your app signing key; key rotation cannot be undone';
}

function tier2Reason(id) {
  if (id === 'reviews.reply') return 'a public reply, visible to everyone on Google Play';
  if (id.startsWith('edits.listings.') || id.startsWith('edits.images.')) {
    return 'store listing content is public on Google Play as soon as it is committed';
  }
  if (id.startsWith('edits.tracks.')) return 'a track change reaches testers or real users (most take effect as soon as they are committed)';
  if (id.startsWith('monetization.') || id.startsWith('inappproducts.')) return 'this affects subscriptions or what customers pay';
  return 'changes to your Google Play app need your confirmation (most take effect as soon as they are committed)';
}
