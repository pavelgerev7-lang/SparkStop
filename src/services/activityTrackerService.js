// Tracks how many distinct visitors have hit the site recently, for the
// admin panel's "active now" figure. Deliberately in-memory only (no DB
// writes, no schema) — this is live/transient data by nature, resetting on
// restart is fine, and it must never add cost to every single request.

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const lastSeenByVisitor = new Map();

// A logged-in user is keyed by their JWT (stable across requests, one entry
// per account); an anonymous visitor is keyed by IP + User-Agent (no
// cookies/session id in this app to key off instead) — good enough to avoid
// wildly overcounting a single browser making several requests per minute,
// without needing any new client-side plumbing.
export function trackActivity(req, res, next) {
  const authHeader = req.headers['authorization'];
  const key = authHeader || `${req.ip}_${req.headers['user-agent'] || ''}`;
  lastSeenByVisitor.set(key, Date.now());
  next();
}

export function getActiveVisitorCount() {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  let count = 0;
  for (const [key, seenAt] of lastSeenByVisitor) {
    if (seenAt >= cutoff) {
      count++;
    } else {
      lastSeenByVisitor.delete(key);
    }
  }
  return count;
}
