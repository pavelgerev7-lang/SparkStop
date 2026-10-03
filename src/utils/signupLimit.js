import crypto from 'crypto';
import { query } from '../config/db.js';

// At most MAX accounts may be created from one network address in 24 hours (default 25, changeable with the
// MAX_ACCOUNTS_PER_IP_PER_DAY environment variable). Turnstile, the honeypot and the 12-requests-per-15-minutes mail
// limit make a bot slow; this is the hard ceiling on what a bot that gets through can still create.
//
// Why a rolling 24 hours and not "10 for ever": one public address is often thousands of ordinary people (mobile
// carriers, schools), and a lifetime ceiling would lock them out for good.
//
// What is stored: only a keyed hash of the address (HMAC with the server secret, cut to 32 hex characters), never the
// address itself, and rows older than two days are deleted — the table cannot be used to list who registered.
export const MAX_ACCOUNTS_PER_IP_PER_DAY = Math.max(1, parseInt(process.env.MAX_ACCOUNTS_PER_IP_PER_DAY, 10) || 25);
const DAY_MS = 24 * 60 * 60 * 1000;

export function hashIp(ip) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'sparkstop-signup-limit').update(String(ip)).digest('hex').slice(0, 32);
}

const memory = new Map(); // hash -> [timestamps] — used when there is no PostgreSQL (local development, tests)
let tableReady = null;

// true = PostgreSQL is used, false = the in-memory fallback.
async function usePostgres() {
  if (!tableReady) {
    tableReady = (async () => {
      try {
        const created = await query(`CREATE TABLE IF NOT EXISTS signup_log (
          ip_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        if (!created) return false; // no database: query() answers null
        await query(`CREATE INDEX IF NOT EXISTS idx_signup_log_ip ON signup_log (ip_hash, created_at DESC)`);
        return true;
      } catch (err) {
        console.warn('⚠️ signup_log table is not available — using the in-memory counter:', err.message);
        return false;
      }
    })();
  }
  return tableReady;
}

/** How many accounts were created from this address in the last 24 hours. */
export async function accountsCreatedFromIp(ip, now = Date.now()) {
  if (!ip) return 0;
  const h = hashIp(ip);
  try {
    if (await usePostgres()) {
      const r = await query(`SELECT COUNT(*)::int AS n FROM signup_log WHERE ip_hash = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [h]);
      return r && r.rows && r.rows[0] ? r.rows[0].n : 0;
    }
  } catch (err) {
    // A counting problem must never stop a real person from registering.
    console.warn('⚠️ Could not count accounts for an address:', err.message);
    return 0;
  }
  const recent = (memory.get(h) || []).filter((t) => t > now - DAY_MS);
  memory.set(h, recent);
  return recent.length;
}

/** Throws a 429 when this address already created the maximum number of accounts today. No address = no limit. */
export async function assertIpMayCreateAccount(ip, now = Date.now()) {
  if (!ip) return;
  if (await accountsCreatedFromIp(ip, now) >= MAX_ACCOUNTS_PER_IP_PER_DAY) {
    const error = new Error(`От тази мрежа вече са създадени ${MAX_ACCOUNTS_PER_IP_PER_DAY} профила за последното денонощие (максимумът). Опитай пак утре.`);
    error.statusCode = 429;
    throw error;
  }
}

/** Remember that an account was just created from this address. */
export async function recordAccountCreated(ip, now = Date.now()) {
  if (!ip) return;
  const h = hashIp(ip);
  try {
    if (await usePostgres()) {
      await query(`INSERT INTO signup_log (ip_hash) VALUES ($1)`, [h]);
      await query(`DELETE FROM signup_log WHERE created_at < NOW() - INTERVAL '2 days'`);
      return;
    }
  } catch (err) {
    console.warn('⚠️ Could not record a new account for an address:', err.message);
  }
  const list = (memory.get(h) || []).filter((t) => t > now - DAY_MS);
  list.push(now);
  memory.set(h, list);
  if (memory.size > 20000) memory.clear(); // never grow without bound
}
