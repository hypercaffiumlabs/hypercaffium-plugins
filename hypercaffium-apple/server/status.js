// Turns raw App Store Connect data into one plain "where is my app?" answer.
// Kept free of network calls so it can be tested offline.
import { toLocalTime } from './util.js';

// States that mean "this version is not currently being worked on / reviewed / released".
const NOT_IN_FLIGHT = new Set([
  'READY_FOR_SALE',
  'REPLACED_WITH_NEW_VERSION',
  'REMOVED_FROM_SALE',
  'DEVELOPER_REMOVED_FROM_SALE',
  'NOT_APPLICABLE',
]);

const stateOf = (v) => v.appStoreState || v.appVersionState || 'UNKNOWN';
const newestFirst = (a, b) => String(b.createdDate || '').localeCompare(String(a.createdDate || ''));

export function buildAppleStatus({ app, versions = [], builds = [], phased = null }) {
  const sorted = [...versions].sort(newestFirst);
  const live = sorted.find((v) => stateOf(v) === 'READY_FOR_SALE');
  const inFlight = sorted.filter((v) => !NOT_IN_FLIGHT.has(stateOf(v)));
  return {
    store: 'apple',
    app: { id: app.id, name: app.name, bundleId: app.bundleId },
    live: live
      ? {
          version: live.versionString,
          platform: live.platform,
          state: stateOf(live),
          createdLocal: toLocalTime(live.createdDate),
          phasedRelease: phased
            ? {
                state: phased.phasedReleaseState,
                currentDayNumber: phased.currentDayNumber,
                startedLocal: toLocalTime(phased.startDate),
              }
            : null,
        }
      : null,
    inFlight: inFlight.map((v) => ({
      version: v.versionString,
      platform: v.platform,
      state: stateOf(v),
      createdLocal: toLocalTime(v.createdDate),
    })),
    latestBuilds: builds.map((b) => ({
      build: b.version,
      processingState: b.processingState,
      uploadedLocal: toLocalTime(b.uploadedDate),
      expired: b.expired,
      expiresLocal: toLocalTime(b.expirationDate),
    })),
  };
}
