// Short bans for visitors that behave like bots on the forms that send a code e-mail. Every refused bot request adds
// "strikes" to the visitor's address; at 5 strikes within an hour the address is blocked for an hour from the
// endpoints bots abuse (register, resend / forgot / reset password, verify code, save address) — NOT from the map
// or the rest of the site. Many people share one public address (mobile carriers put thousands behind one), so a
// ban must never take away the site itself, only the few actions a bot is after.
// In memory only: a restart clears it, and nothing personal is stored beyond the hour (no logs of the address).
const WINDOW_MS = 60 * 60 * 1000;
const BAN_MS = 60 * 60 * 1000;
const THRESHOLD = 5;
const MAX_ENTRIES = 20000;

// A person can never fill the hidden field, so that alone is a ban; a too-fast submit is weaker evidence (an
// autofill + instant click), and a failed Turnstile answer weaker still (an expired token).
export const STRIKE = { HONEYPOT: 5, TOO_FAST: 2, TURNSTILE: 1 };

const entries = new Map(); // key -> { score, firstAt, bannedUntil }

function prune(now) {
  for (const [k, e] of entries) {
    if (e.bannedUntil <= now && now - e.firstAt > WINDOW_MS) entries.delete(k);
  }
  if (entries.size > MAX_ENTRIES) {
    // Still too many (an address flood): drop the oldest tenth rather than grow without bound.
    const oldest = [...entries.entries()].sort((a, b) => a[1].firstAt - b[1].firstAt).slice(0, Math.ceil(MAX_ENTRIES / 10));
    for (const [k] of oldest) entries.delete(k);
  }
}

/** Adds strikes; returns { banned, justBanned }. */
export function recordBotStrike(key, weight, now = Date.now()) {
  if (!key) return { banned: false, justBanned: false };
  if (entries.size >= MAX_ENTRIES) prune(now);
  let e = entries.get(key);
  if (!e || (e.bannedUntil <= now && now - e.firstAt > WINDOW_MS)) {
    e = { score: 0, firstAt: now, bannedUntil: 0 };
    entries.set(key, e);
  }
  const wasBanned = e.bannedUntil > now;
  e.score += weight;
  if (!wasBanned && e.score >= THRESHOLD) e.bannedUntil = now + BAN_MS;
  const banned = e.bannedUntil > now;
  return { banned, justBanned: banned && !wasBanned };
}

export function isBotBanned(key, now = Date.now()) {
  const e = key ? entries.get(key) : null;
  return !!e && e.bannedUntil > now;
}

export function botBanSize() { return entries.size; }
export function resetBotBans() { entries.clear(); }
