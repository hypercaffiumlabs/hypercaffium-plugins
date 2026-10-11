// Small shared helpers: time conversion and output size limits.

// Apple returns Pacific-style offsets and Google returns UTC; show the owner's own time zone instead.
// Set "timezone" (an IANA name such as "America/Chicago") in the plugin config file, or the
// HYPERCAFFIUM_TIMEZONE environment variable. Default: this computer's time zone.
export function getTimezone() {
  const wanted = process.env.HYPERCAFFIUM_TIMEZONE;
  if (wanted) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: wanted });
      return wanted;
    } catch {
      // an invalid name falls through to the computer's own zone
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function toLocalTime(value) {
  if (!value) return value;
  const d = new Date(typeof value === 'object' && value.seconds ? Number(value.seconds) * 1000 : value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-US', {
    timeZone: getTimezone(),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export const MAX_OUTPUT_CHARS = 60000;

// Keep tool results small enough to be useful; say so clearly when something was cut.
export function limitText(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[... output cut at ${max} characters; ask for fewer items, add filters, or use the nextPage link ...]`;
}
