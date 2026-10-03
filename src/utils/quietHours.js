// "Dead hours" for the background jobs. Neon bills the database's compute for every hour it is awake,
// and it only falls asleep after a few minutes without a query — the scraper, the integrity sweep and
// the retention job keep it awake around the clock. Between QUIET_HOURS (default 01:00–06:00 Sofia
// time) the server starts none of them, so the database can suspend. Visitors are still served; a
// request only wakes the database for a moment.
//
// QUIET_HOURS   "1-6" (from 01:00 until 06:00, end excluded); "23-5" wraps past midnight;
//               "off" turns the pause off. Unset = default. Hours are whole numbers 0–24.
// QUIET_TIMEZONE  IANA zone the hours refer to, default Europe/Sofia (so summer/winter time is handled).

export const DEFAULT_QUIET_HOURS = '1-6';
export const DEFAULT_QUIET_TIMEZONE = 'Europe/Sofia';

const OFF_WORDS = new Set(['off', 'none', 'false', 'no', 'disabled']);

/** "1-6" -> { start: 1, end: 6 }; null when the pause is switched off or the text is not a valid window. */
export function parseQuietHours(spec) {
  const text = String(spec ?? '').trim().toLowerCase();
  if (!text || OFF_WORDS.has(text)) return null;
  const m = text.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 24 || end > 24 || start === end) return null;
  return { start: start % 24, end };
}

const formatters = new Map();
function hourIn(timeZone, date) {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' });
    } catch {
      // An unknown zone name in the environment must not take the server down — use the default one.
      f = new Intl.DateTimeFormat('en-GB', { timeZone: DEFAULT_QUIET_TIMEZONE, hour: 'numeric', hourCycle: 'h23' });
    }
    formatters.set(timeZone, f);
  }
  return Number(f.formatToParts(date).find((p) => p.type === 'hour').value);
}

/** True while `now` falls inside the quiet window. */
export function isQuietHours(now = new Date(), {
  spec = process.env.QUIET_HOURS || DEFAULT_QUIET_HOURS,
  timeZone = process.env.QUIET_TIMEZONE || DEFAULT_QUIET_TIMEZONE
} = {}) {
  const window = parseQuietHours(spec);
  if (!window) return false;
  const hour = hourIn(timeZone, now);
  return window.start < window.end
    ? hour >= window.start && hour < window.end
    : hour >= window.start || hour < window.end; // wraps past midnight
}

/** Human-readable window for the start-up log and the health endpoint. */
export function describeQuietHours({
  spec = process.env.QUIET_HOURS || DEFAULT_QUIET_HOURS,
  timeZone = process.env.QUIET_TIMEZONE || DEFAULT_QUIET_TIMEZONE
} = {}) {
  const window = parseQuietHours(spec);
  if (!window) return 'off';
  const pad = (h) => String(h).padStart(2, '0');
  return `${pad(window.start)}:00–${pad(window.end)}:00 ${timeZone}`;
}
