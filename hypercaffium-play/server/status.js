// Turns raw Google Play track data into one plain "where is my app?" answer.
// Free of network calls so it can be tested offline.
const percent = (fraction) => (fraction === undefined || fraction === null ? null : Math.round(Number(fraction) * 10000) / 100);

const summarizeRelease = (r) => ({
  name: r.name,
  status: r.status, // draft | inProgress | halted | completed
  versionCodes: (r.versionCodes || []).map(Number),
  rolloutPercent: r.status === 'inProgress' || r.status === 'halted' ? percent(r.userFraction) : r.status === 'completed' ? 100 : null,
});

export function buildPlayStatus({ packageName, tracks = [], bundles = [], details = null }) {
  const byName = Object.fromEntries(tracks.map((t) => [t.track, t.releases || []]));
  const production = (byName.production || []).map(summarizeRelease);
  const live = production.find((r) => r.status === 'completed') || null;
  const rollingOut = production.find((r) => r.status === 'inProgress') || null;
  const halted = production.find((r) => r.status === 'halted') || null;
  const drafts = production.filter((r) => r.status === 'draft');
  const otherTracks = tracks
    .filter((t) => t.track !== 'production')
    .map((t) => ({ track: t.track, releases: (t.releases || []).map(summarizeRelease) }))
    .filter((t) => t.releases.length > 0);
  const codes = bundles.map((b) => Number(b.versionCode)).filter((n) => !Number.isNaN(n));
  return {
    store: 'google',
    package: packageName,
    app: details ? { defaultLanguage: details.defaultLanguage, contactEmail: details.contactEmail } : undefined,
    live,
    rollingOut,
    halted,
    drafts,
    otherTracks,
    latestUploadedVersionCode: codes.length ? Math.max(...codes) : null,
  };
}
