// The feature switches both store plugins share. Each plugin bundles its own copy at build time.
//
// A feature that is switched off is refused by the server for every route (dedicated tools and the
// general-purpose prepare tool alike). Critical features start off, and only the terminal setup menu
// (which needs a real keyboard) switches them on; the in-chat settings tool can only switch them off.
import fs from 'node:fs';
import path from 'node:path';

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];

export const RISK_LABEL = {
  low: 'Low risk: only testers see it, easy to undo',
  medium: 'Medium risk: public, but easy to change back',
  high: 'High risk: reaches real users or money',
  critical: 'Critical: access, signing or customer money',
};

// label/help can differ per store: { apple, play } objects, or one string for both.
// An entry without `stores` applies to apple and play only.
export const FEATURES = [
  {
    key: 'testing',
    risk: 'low',
    label: { apple: 'TestFlight', play: 'Testing tracks and testers' },
    help: {
      apple: 'Notes for testers, adding and removing testers, builds in groups, external beta review, expiring builds.',
      play: 'Who can test your app on the internal, closed and open testing tracks.',
    },
  },
  {
    key: 'listing',
    risk: 'medium',
    label: 'Store listing',
    help: 'App name, description, keywords, screenshots, preview videos, App Review details and similar listing content.',
  },
  {
    key: 'reviews',
    risk: 'medium',
    label: 'Review replies',
    help: 'Public replies to customer reviews.',
  },
  {
    key: 'marketing',
    risk: 'medium',
    label: 'Marketing pages',
    stores: ['apple'], // Google's API has no custom store listings or listing experiments.
    help: 'Custom product pages, in-app events and product page tests.',
  },
  {
    key: 'releases',
    risk: 'high',
    label: 'Releases',
    help: {
      apple: 'Creating versions, attaching builds, submitting for review, phased release, releasing, availability.',
      play: 'Putting versions on tracks, staged rollouts, halting, promoting, release notes.',
    },
  },
  {
    key: 'pricing',
    risk: 'high',
    label: 'Prices and offers',
    help: 'Subscriptions, in-app purchases, prices, moving existing subscribers to a new price, offers and offer codes.',
  },
  {
    key: 'uploads',
    risk: 'high',
    label: 'Uploading app files',
    help: {
      apple: 'Uploading a build. Skip this if EAS, Xcode or fastlane uploads your builds.',
      play: 'Uploading an .aab app bundle and its crash-decoding (mapping) file. Skip this if EAS or Gradle uploads for you.',
    },
  },
  {
    key: 'advanced',
    risk: 'high',
    label: 'Everything else in the API',
    help: 'Rarely used areas the dedicated tools do not cover (for example Game Center or app recovery). Still previewed and confirmed.',
  },
  {
    key: 'users',
    risk: 'critical',
    label: 'Users and permissions',
    help: 'Inviting people to your developer account, changing their access, removing them.',
  },
  {
    key: 'signing',
    risk: 'critical',
    label: 'Signing keys',
    help: {
      apple: 'Certificates, provisioning profiles, bundle IDs and devices. Changing these can break builds made by EAS or Xcode.',
      play: 'Enrolling in and rotating the app signing key. Rotation cannot be undone.',
    },
  },
  {
    key: 'refunds',
    risk: 'critical',
    label: 'Refunds and orders',
    stores: ['play'], // Apple's API has no refund or order actions; Apple handles refunds itself.
    help: 'Refunding orders and cancelling, revoking or deferring customer subscriptions.',
  },
  {
    key: 'apis',
    risk: 'low',
    label: 'Turn on Google APIs',
    stores: ['google'],
    help: 'Enabling a Google API on a project that is not live.',
  },
  {
    key: 'projects',
    risk: 'medium',
    label: 'New projects',
    stores: ['google'],
    help: 'Creating a new, empty Google Cloud project. No billing is linked, so it costs nothing.',
  },
  {
    key: 'testUsers',
    risk: 'low',
    label: 'Test users',
    stores: ['google'],
    help: 'Adding people to the test user list of an app that is still in Testing.',
  },
  {
    key: 'branding',
    risk: 'medium',
    label: 'Branding',
    stores: ['google'],
    help: 'Editing the app name, logo, support email and links shown on the Google sign-in screen.',
  },
  {
    key: 'scopes',
    risk: 'medium',
    label: 'Scopes',
    stores: ['google'],
    help: 'Adding the permissions your app asks people to grant when they sign in.',
  },
  {
    key: 'clients',
    risk: 'medium',
    label: 'Sign-in clients',
    stores: ['google'],
    help: 'Creating OAuth clients, the IDs your app uses to start a Google sign-in.',
  },
  {
    key: 'signIns',
    risk: 'medium',
    label: 'Account sign-ins',
    stores: ['google'],
    help: 'Signing in Google accounts so Claude can act on their behalf.',
  },
  {
    key: 'publishing',
    risk: 'high',
    label: 'Publishing to production',
    stores: ['google'],
    help: 'Moving an app from Testing to In production so anyone can sign in.',
  },
  {
    key: 'liveProjects',
    risk: 'high',
    label: 'Changes on live projects',
    stores: ['google'],
    help: 'Any change to a project you have marked as live.',
  },
  {
    key: 'destructive',
    risk: 'critical',
    label: 'Removing or resetting sign-in setup',
    stores: ['google'],
    help: 'Deleting a client or its secret, removing scopes from a live project, or moving an app back to Testing.',
  },
];

export const featuresFor = (store) => FEATURES.filter((f) => (f.stores || ['apple', 'play']).includes(store));
export const pick = (value, store) => (value && typeof value === 'object' ? value[store] : value);
export const isCritical = (key) => FEATURES.some((f) => f.key === key && f.risk === 'critical');
export const defaultOn = (key) => !isCritical(key);

// The effective switches: every known feature, from the file where set, else the default.
// Anything that is not exactly true/false in the file falls back to the default.
export function resolveFeatures(fileFeatures, store) {
  const out = {};
  for (const f of featuresFor(store)) {
    const v = fileFeatures && typeof fileFeatures === 'object' ? fileFeatures[f.key] : undefined;
    out[f.key] = typeof v === 'boolean' ? v : defaultOn(f.key);
  }
  return out;
}

// For tool output and menus: the switches grouped by risk level, with plain-English labels.
export function describeFeatures(features, store) {
  return RISK_LEVELS.map((risk) => ({
    risk,
    riskLabel: RISK_LABEL[risk],
    features: featuresFor(store)
      .filter((f) => f.risk === risk)
      .map((f) => ({ key: f.key, label: pick(f.label, store), on: Boolean(features[f.key]), help: pick(f.help, store) })),
  })).filter((g) => g.features.length);
}

// Merge new values into the settings file, keeping every other key, and write it atomically.
// opts.allowCriticalOn: only the terminal menu passes true.
export function saveSettings(configPath, changes, store, { allowCriticalOn = false } = {}) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`${configPath} exists but is not valid JSON, so it was not changed: ${err.message}`);
  }
  const next = { ...current };
  const { features, ...rest } = changes;
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) next[k] = v;
  }
  if (features) {
    const known = new Set(featuresFor(store).map((f) => f.key));
    const merged = { ...resolveFeatures(current.features, store) };
    for (const [k, v] of Object.entries(features)) {
      if (!known.has(k)) throw new Error(`Unknown feature "${k}". Known: ${[...known].join(', ')}.`);
      if (typeof v !== 'boolean') throw new Error(`Feature "${k}" must be true or false.`);
      if (v && isCritical(k) && !merged[k] && !allowCriticalOn) {
        throw new Error(`"${k}" is a critical feature. It can only be switched on in the terminal setup menu, not from the chat.`);
      }
      merged[k] = v;
    }
    next.features = merged;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, configPath);
  return next;
}
