import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'local_db.json');

const { Pool } = pg;

let pool = null;
let isPgAvailable = false;

// In-Memory & Local File Storage Fallback (used when PostgreSQL database is not connected)
export const inMemoryDB = {
  users: [
    {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      email: 'demo@sparkdrop.bg',
      phone: '+359888123456',
      fcm_token: 'demo_fcm_token_xyz_98765',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  ],
  saved_addresses: [],
  outages: [],
  notification_log: [],
  // Simple cumulative counter of successful logins/registrations, shown on
  // the admin panel. Not a full analytics system — just a running total,
  // persisted the same way as everything else here.
  siteStats: { totalLogins: 0 }
};

// Load saved data from disk if available
export function loadLocalDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf-8');
      const data = JSON.parse(content);
      if (data && typeof data === 'object') {
        if (Array.isArray(data.users)) inMemoryDB.users = data.users;
        if (Array.isArray(data.saved_addresses)) inMemoryDB.saved_addresses = data.saved_addresses;
        if (Array.isArray(data.outages)) inMemoryDB.outages = data.outages;
        if (Array.isArray(data.notification_log)) inMemoryDB.notification_log = data.notification_log;
        if (data.siteStats && typeof data.siteStats === 'object') {
          inMemoryDB.siteStats = { totalLogins: 0, ...data.siteStats };
        }
        console.log(`💾 [Local DB] Заредени са ${inMemoryDB.saved_addresses.length} запазени адреса и ${inMemoryDB.outages.length} аварии от локалния диск.`);
      }
    }
  } catch (err) {
    console.warn('⚠️ Could not load local_db.json:', err.message);
  }
}

// Persist inMemoryDB to disk. The scraper alone can call this dozens of times
// in quick succession (once per upserted outage) — with a ~10MB+ DB file,
// synchronously re-serializing and rewriting the WHOLE thing on every single
// call blocked the entire Node event loop for each write, so unrelated
// requests (e.g. a user's address-search keystroke) landing mid-scrape had to
// wait behind however many blocking writes were queued ahead of them.
// inMemoryDB is always the live source of truth during the process's
// lifetime (the file is only ever read once, at startup) — so batching
// writes behind a short trailing debounce, and doing the actual write async,
// is safe: nothing in this process re-reads the file mid-run.
let persistTimer = null;
let persistPending = false;
const PERSIST_DEBOUNCE_MS = 2000;
const TMP_FILE = `${DB_FILE}.tmp-${process.pid}`;

// Writing straight to DB_FILE meant a process kill/crash mid-write (OOM,
// host restart) could leave truncated/invalid JSON on disk — the next boot's
// JSON.parse would throw, get swallowed by the warn-and-continue in
// loadLocalDB(), and silently reset every saved address and the entire
// outage history back to the hardcoded defaults with no trace of what
// happened. Writing to a temp file and renaming over the target is atomic
// on the same filesystem (the OS never exposes a half-written state under
// DB_FILE's name), so a crash mid-write just loses that one pending flush,
// never corrupts what was already durably saved.
//
// Chained through this promise (rather than firing fs.writeFile calls
// independently) so a second flush triggered while the first is still
// in-flight can't have its completion callback land first — Node doesn't
// guarantee ordering between concurrent writes dispatched to the thread
// pool, so without this an older, already-superseded snapshot could
// overwrite a newer one purely by finishing second... old code did that.
let writeChain = Promise.resolve();

function flushLocalDB() {
  persistTimer = null;
  persistPending = false;
  // Captured now (synchronously, at the moment this debounced flush actually
  // fires) so it reflects everything mutated up to this point — later
  // mutations get their own persistLocalDB() call and their own snapshot.
  const snapshot = JSON.stringify(inMemoryDB, null, 2);
  writeChain = writeChain.then(() => new Promise((resolve) => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFile(TMP_FILE, snapshot, 'utf-8', (err) => {
        if (err) { console.warn('⚠️ Could not persist local_db.json:', err.message); return resolve(); }
        fs.rename(TMP_FILE, DB_FILE, (err2) => {
          if (err2) console.warn('⚠️ Could not finalize local_db.json write:', err2.message);
          resolve();
        });
      });
    } catch (err) {
      console.warn('⚠️ Could not persist local_db.json:', err.message);
      resolve();
    }
  }));
}

export function persistLocalDB() {
  persistPending = true;
  if (persistTimer) return; // a flush is already scheduled
  persistTimer = setTimeout(flushLocalDB, PERSIST_DEBOUNCE_MS);
}

// Best-effort final flush so a deploy/restart doesn't drop whatever was
// still waiting behind the debounce. Synchronous (process.on('exit') can't
// await), but still atomic via the same temp-then-rename swap.
function flushLocalDBSync() {
  if (!persistPending) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  persistPending = false;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TMP_FILE, JSON.stringify(inMemoryDB, null, 2), 'utf-8');
    fs.renameSync(TMP_FILE, DB_FILE);
  } catch (err) {
    console.warn('⚠️ Could not persist local_db.json on shutdown:', err.message);
  }
}
process.on('SIGTERM', flushLocalDBSync);
process.on('SIGINT', flushLocalDBSync);
process.on('exit', flushLocalDBSync);

// Initial load
loadLocalDB();

if (process.env.DATABASE_URL) {
  // Any real hosted Postgres (Neon, Supabase, Render Postgres) requires
  // SSL — gating this on NODE_ENV meant a local .env pointed at one of
  // these (e.g. testing against the real production database before
  // deploying) explicitly disabled SSL and failed to connect at all,
  // silently falling back to the local-file DB with no indication why.
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000
  });

  // Test connection — awaited (top-level await; this file is ESM) rather
  // than fire-and-forget with a callback. isPgAvailable starts false, and
  // server.js imports this module then immediately calls app.listen(),
  // whose callback fires the STARTUP scraper run synchronously. Without
  // awaiting here, every one of those — plus any request that happens to
  // land in the first moment after a restart/redeploy — ran before the
  // callback had a chance to flip isPgAvailable to true, so query() sent
  // them all down the in-memory/local-file fallback despite a perfectly
  // reachable DATABASE_URL.
  //
  // Neon's free-tier compute auto-suspends after a few minutes of no
  // queries and "cold starts" back up on the next one — confirmed live:
  // a restart that landed while Neon was suspended blew straight through
  // the previous 3s timeout on the very first (and, with no retry, ONLY)
  // attempt, and the process then ran its entire lifetime silently
  // stranded in the in-memory/local-file fallback despite Postgres being
  // perfectly reachable moments later — serving/writing the wrong data
  // the whole time with no error visible to a user. Retrying a few times
  // with backoff means one slow cold start can't permanently strand an
  // otherwise-healthy process.
  const CONNECT_RETRY_DELAYS_MS = [1000, 3000, 6000];
  let connected = false;
  for (let attempt = 0; !connected; attempt++) {
    try {
      await pool.query('SELECT NOW()');
      console.log('✅ PostgreSQL database connected successfully.');
      isPgAvailable = true;
      connected = true;
    } catch (err) {
      if (attempt < CONNECT_RETRY_DELAYS_MS.length) {
        const delay = CONNECT_RETRY_DELAYS_MS[attempt];
        console.warn(`⚠️ PostgreSQL connection attempt ${attempt + 1} failed (${err.message}) — retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.warn('⚠️ PostgreSQL connection failed after retries. Falling back to persistent in-memory DB:', err.message);
        isPgAvailable = false;
        break;
      }
    }
  }
  // Notification history ("Съобщения") must survive a deploy — see notificationService.logNotificationHistory.
  if (isPgAvailable) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS notification_log (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        address_id TEXT,
        address_label TEXT,
        city TEXT,
        street TEXT,
        utility_type TEXT,
        message TEXT,
        outage_id TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_notification_log_user ON notification_log (user_id, sent_at DESC)`);
      await pool.query(`DELETE FROM notification_log WHERE sent_at < NOW() - INTERVAL '90 days'`);
      // Which reminders (24 h before / 1 h before / ended) were already pushed to which device — see reminderService.js.
      await pool.query(`CREATE TABLE IF NOT EXISTS outage_reminders (
        dedupe_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        outage_id TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query(`DELETE FROM outage_reminders WHERE sent_at < NOW() - INTERVAL '14 days'`);
    } catch (err) {
      console.warn('⚠️ Could not prepare the notification_log table:', err.message);
    }
  }
} else {
  console.log('ℹ️ DATABASE_URL not set in .env. Running with persistent local DB mode.');
}

// Counts every statement that writes to the outages table, so a cached copy of its rows (the live map's
// night-time cache) can tell whether anything has changed since it was read — whoever wrote it.
let outagesWriteVersion = 0;
const OUTAGES_WRITE_RE = /^\s*(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+outages\b/i;
export function getOutagesWriteVersion() {
  return outagesWriteVersion;
}

/**
 * Execute a SQL query or use in-memory fallback
 */
export async function query(text, params) {
  if (OUTAGES_WRITE_RE.test(text)) outagesWriteVersion++;
  if (isPgAvailable && pool) {
    return pool.query(text, params);
  }
  return null;
}

// Called on every successful login/registration. Kept in the same
// local-file layer regardless of Postgres availability — Postgres has no
// counters table for this (and isn't reachable right now anyway), and this
// is a simple running total, not data that needs relational storage.
export function recordLogin() {
  inMemoryDB.siteStats.totalLogins = (inMemoryDB.siteStats.totalLogins || 0) + 1;
  persistLocalDB();
}

export function getDbStatus() {
  return {
    isPgAvailable,
    mode: isPgAvailable ? 'PostgreSQL/Supabase' : 'PersistentLocalFileDB'
  };
}

