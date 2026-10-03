// СпаркСтоп (SparkStop) — © 2026 Pavel Gerev. Created for the John Atanasov Award.
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { getDbStatus } from './config/db.js';
import {
  saveAddressHandler,
  getUserAddressesHandler,
  getCitiesHandler,
  autocompleteAddressHandler,
  deleteAddressHandler,
  updateAddressNotificationHandler,
  autocompleteSettlementHandler,
  getProvincesHandler,
  getMunicipalitiesHandler,
  getSettlementsHandler,
  autocompleteProvincesHandler,
  autocompleteMunicipalitiesHandler,
  verifyHouseNumberHandler
} from './controllers/addressController.js';
import {
  checkOutageHandler,
  liveMapHandler,
  triggerScraperHandler,
  manualAddOutageHandler,
  outagesTableHandler
} from './controllers/outageController.js';
import {
  registerHandler,
  resendRegistrationCodeHandler,
  verifyRegistrationHandler,
  loginHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  getMeHandler,
  deleteAccountHandler
} from './controllers/authController.js';
import { configureEgress, lookupEgressAddress } from './utils/egress.js';
import { runScraperJob, runDryRunAudit, getDryRunAuditState, commitApprovedCandidates, listManualAnnouncementProviders, previewManualAnnouncement } from './services/scraperService.js';
import { pruneOldOutages, runDataIntegritySweep, refreshLiveMapSnapshot } from './services/outageService.js';
import { runUrlHealthCheck, getLastUrlHealthReport } from './services/urlHealthService.js';
import { getScraperHealthSummary, recordScraperRun } from './services/scraperHealthService.js';
import { classifyAdminChatMessage, executeAdminChatAction } from './services/aiCommandChatService.js';
import { getTurnstileSiteKey } from './services/turnstileService.js';
import { clientKey } from './utils/clientKey.js';
import { isBotBanned } from './utils/botBan.js';
import { normalizeQuery } from './utils/queryNormalizer.js';
import { runSourceContentAudit, getLastSourceAuditReport } from './services/sourceAuditService.js';
import { suggestCodeFixForIssue } from './services/codeFixSuggestionService.js';
import { getStatsHandler } from './controllers/adminController.js';
import { trackActivity } from './services/activityTrackerService.js';
import { getNotificationHistoryHandler, sendTestNotificationHandler } from './controllers/notificationController.js';
import { verifyAuthToken } from './services/authService.js';
import { isQuietHours, describeQuietHours } from './utils/quietHours.js';
import { runReminderJob } from './services/reminderService.js';

// The background jobs below do nothing during the quiet hours (default 01:00–06:00 Sofia time,
// see utils/quietHours.js), so the database has no work and can suspend — its compute is billed per
// awake hour. Logs once when the state flips, not on every skipped tick.
let quietAnnounced = null;
function inQuietHours() {
  const quiet = isQuietHours();
  if (quiet !== quietAnnounced) {
    quietAnnounced = quiet;
    console.log(quiet
      ? `😴 [QUIET HOURS] ${describeQuietHours()}: scraper, integrity sweep and retention paused so the database can suspend.`
      : `⏰ [QUIET HOURS] Outside the quiet window (${describeQuietHours()}): background jobs run normally.`);
  }
  return quiet;
}

const OWNER_EMAIL = 'pavelgerev7@gmail.com';

// These endpoints trigger scrapes, inject outage records, or expose internal
// stats — the frontend only shows their UI to the owner, but the routes
// themselves had no server-side check at all, so anyone who found the URL
// (visible in the client JS) could hit them directly.
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const session = verifyAuthToken(token);
  if (!session || !session.email || session.email.toLowerCase() !== OWNER_EMAIL) {
    return res.status(403).json({ success: false, message: 'Достъпът е ограничен само за собственика на приложението.' });
  }
  next();
}

dotenv.config();

// Optional fixed outgoing address for provider requests (SCRAPER_PROXY_URL) —
// see utils/egress.js. Does nothing when the variable is not set.
configureEgress();

// Safety net, not a fix for anything specific: every fire-and-forget
// background job in this file (scraper cron, dry-run trigger, url-health,
// prune, integrity sweep) already attaches its own .catch() — confirmed by
// grep, none were missing one. This is purely defensive for whatever
// SLIPS THROUGH that in the future (a genuinely unexpected rejection
// somewhere else), so it gets logged loudly instead of either crashing the
// whole process (Node's default for uncaughtException) or vanishing
// silently (the historical default for unhandledRejection, before Node
// made it a warning) — visibility either way, never a fix on its own.
process.on('unhandledRejection', (reason) => {
  console.error('🚨 [UNHANDLED REJECTION]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('🚨 [UNCAUGHT EXCEPTION]', err.stack || err.message);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const app = express();
const PORT = process.env.PORT || 3000;

// ====================================================================
// Middlewares
// ====================================================================

// helmet sets a broad set of protective HTTP headers (X-Frame-Options
// against clickjacking, X-Content-Type-Options against MIME-sniffing,
// Strict-Transport-Security, etc.) — all safe/zero-risk defaults. Its CSP
// is configured explicitly below rather than left at helmet's own default,
// since the default is stricter than this page needs (it loads Leaflet/
// Firebase/Tailwind/fonts from several CDNs) and the site's admin panel
// relies on inline onclick="" handlers throughout, which a CSP without
// 'unsafe-inline' would silently break. This still meaningfully restricts
// which SOURCES scripts/styles/connections can come from — a real barrier
// against an attacker's payload pulling in code or exfiltrating data via
// an arbitrary external domain — even though inline execution itself
// stays allowed. crossOriginEmbedderPolicy is off because it can break
// loading the third-party CDN assets above without those assets sending
// their own CORP/CORS headers back.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Leaflet/Lucide/Firebase/Tailwind/Google Fonts are now ALL served
      // from 'self' (see index.html + sw.js) — the map tiles are the only
      // remaining genuinely external load (imgSrc/connectSrc below), since
      // OpenStreetMap's own tile servers can't be mirrored the same way.
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://challenges.cloudflare.com'],
      // helmet defaults script-src-attr/style-src-attr to 'none' UNLESS set
      // explicitly here — that default does NOT inherit 'unsafe-inline' from
      // scriptSrc/styleSrc above, it's a separate, more specific directive
      // that governs inline onclick=""/style="" ATTRIBUTES specifically.
      // Confirmed live: this silently blocked every onclick="" handler
      // site-wide (login button, every admin panel action, everything) —
      // this codebase relies on inline handlers throughout, so this must be
      // explicitly allowed too, not just plain <script> tags.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'"],
      // Map tiles: see the tileLayer comment in index.html for the full
      // OSM -> CARTO -> Esri -> MapTiler story. server.arcgisonline.com is
      // no longer used by the active tile layer but stays whitelisted since
      // other features (geocoding) still call Esri's ArcGIS services.
      imgSrc: ["'self'", 'data:', 'blob:', 'https://server.arcgisonline.com', 'https://api.maptiler.com'],
      connectSrc: ["'self'", 'https://challenges.cloudflare.com', 'https://firebaseinstallations.googleapis.com', 'https://fcmregistrations.googleapis.com', 'https://fcm.googleapis.com', 'https://server.arcgisonline.com', 'https://api.maptiler.com'],
      // Cloudflare Turnstile draws its check inside an iframe from challenges.cloudflare.com (registration form).
      frameSrc: ['https://challenges.cloudflare.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"]
    }
  },
  // helmet's default is "no-referrer": the map-tile requests then carry no Referer at all, so MapTiler cannot tell
  // they come from this site and an "Allowed HTTP origins" restriction on the (public, in-page) tile key would blank
  // the map. This sends only the bare origin (https://sparkstopapp.com, never a path or query) to other sites, and
  // nothing at all on a downgrade to http — the browsers' own default.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false
}));

// CORS: only the real domain (and localhost, for local development) may
// make cross-origin browser requests — was previously cors() with no
// restriction at all (any website could drive a visitor's browser into
// calling this API cross-origin). This is a browser-side defense (it
// cannot stop a non-browser client like curl from hitting the API
// directly, CORS was never designed to) — the actual access control for
// anything sensitive is still requireAdmin's own signed-token check below,
// unchanged and unaffected by this.
const allowedOrigins = ['https://sparkstopapp.com', 'https://www.sparkstopapp.com', 'http://localhost:3000', 'http://127.0.0.1:3000'];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Rate limiting against brute-force/DDoS-style abuse. Two tiers: a broad
// one for the public API (100 req/15min/IP — generous enough for normal
// map/address-check usage, including a page's own polling), and a much
// tighter one scoped ONLY to the login route (5 attempts/15min/IP) against
// password-guessing — registration/reset endpoints deliberately aren't
// covered by the tight one since a real user retrying a 6-digit email code
// a few times is normal, not an attack.
// The visitor is identified by the address Cloudflare saw — see utils/clientKey.js.

// 100 was too low for normal use: an open page (and the Android app) refreshes the map and the saved addresses
// every 30 s = 60 requests per 15 minutes, before a single search or autocomplete keystroke — a few minutes of
// use, or two people on one router / mobile-carrier address, hit "429" and the map went "offline".
const publicApiLimiter = rateLimit({
  keyGenerator: clientKey,
  windowMs: 15 * 60 * 1000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Твърде много заявки от този IP адрес. Опитай пак след малко.' }
});
app.use('/api/', publicApiLimiter);

const loginLimiter = rateLimit({
  keyGenerator: clientKey,
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only failed attempts count toward the brute-force limit
  message: { success: false, message: 'Твърде много неуспешни опити за вход. Опитай пак след 15 минути.' }
});
app.use('/api/auth/login', loginLimiter);

// Endpoints that send an e-mail (registration code, password reset) or accept a 6-digit code: without a limit
// of their own they could be used to e-mail-bomb a third party or to guess codes.
const mailLimiter = rateLimit({
  keyGenerator: clientKey,
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Твърде много опити. Опитай пак след 15 минути.' }
});
app.use(['/api/auth/register', '/api/auth/resend-code', '/api/auth/forgot-password', '/api/auth/verify-registration', '/api/auth/reset-password'], mailLimiter);

// An address that was caught acting like a bot on the e-mail forms (see utils/botBan.js) is shut out of the few
// actions bots abuse for an hour — and only those: the map and everything else keep working for it, since one
// public address can be thousands of ordinary people on a mobile network.
app.use(
  ['/api/auth/register', '/api/auth/resend-code', '/api/auth/forgot-password', '/api/auth/verify-registration', '/api/auth/reset-password', '/api/addresses/save'],
  (req, res, next) => {
    if (isBotBanned(clientKey(req))) {
      return res.status(429).json({ success: false, message: 'Засякохме автоматични заявки от твоята мрежа. Опитай пак след около час.' });
    }
    next();
  }
);

// Saving an address accepts ANY userId the client sends (see sessionMayChangeAddressesOf
// in addressController.js — a guest id is inherently self-issued, nothing server-side
// behind it, so it can't require a session the way a registered account's id does). The
// per-user "max 3 addresses" check only limits ONE userId; a caller that mints a fresh
// one every request has no built-in ceiling at all, and each save also triggers real
// work (geocoding) — a flood of fake addresses cheaply drives up DB rows and Neon compute,
// well before the generic 1200/15min API limit (sized for ordinary map/address polling,
// not bulk writes) would even notice. Nobody legitimately saves more than 3 addresses in
// 15 minutes, let alone across guest ids, so this is tight without risking real users.
const addressWriteLimiter = rateLimit({
  keyGenerator: clientKey,
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Твърде много опити за запазване на адрес. Опитай пак след малко.' }
});
app.use('/api/addresses/save', addressWriteLimiter);

// Default express.json() body limit is 100kb — confirmed live this was too
// small for POST /api/admin/commit-sync: a full nationwide dry-run audit
// (161 candidate outages, each with its own raw text + street list) built
// a JSON payload well past that, and every commit attempt 413'd before the
// route handler ever ran (the frontend only ever saw a generic "failed to
// save" — no indication it was a body-size limit at all). 10mb comfortably
// covers even a full ~70-provider audit result with real headroom to grow.
// Only the admin commit route needs the big limit; every public endpoint (login, register, save address …) took a
// 10 MB body from anyone.
app.use('/api/admin/commit-sync', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Every handler reads query values as strings: make that true (see utils/queryNormalizer.js).
app.use(normalizeQuery);

// Lightweight "active visitors" tracker for the admin panel — see
// activityTrackerService.js. Placed before static serving so it counts
// every real hit (page loads included), not just API calls.
app.use(trackActivity);

// Canonical domain redirect — the site is also still reachable at its
// original Render subdomain (sparkdrop-fecv.onrender.com), which search
// engines would otherwise index as separate, duplicate content alongside
// the real sparkstopapp.com. A permanent redirect tells them definitively
// which URL is canonical instead of splitting ranking signals between two.
app.use((req, res, next) => {
  if (req.hostname === 'sparkdrop-fecv.onrender.com') {
    return res.redirect(301, `https://sparkstopapp.com${req.originalUrl}`);
  }
  next();
});

// Serve static frontend files — an explicit allowlist. This used to be express.static(rootDir), which
// published the WHOLE project folder: source code, schema.sql, render.yaml, the test files and
// data/local_db.json (a committed dev snapshot with user e-mails, phones and push tokens) were all
// downloadable from the live site. Only what the pages/app actually load is served now.
const PUBLIC_ROOT_FILES = new Set([
  'index.html', 'about.html', 'bot.html', 'gdpr.html', 'privacy.html', 'terms.html', 'delete-account.html',
  'manifest.json', 'sw.js', 'robots.txt', 'sitemap.xml',
  'logo.png', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'
]);
app.use('/vendor', express.static(path.join(rootDir, 'vendor')));
// Android app (Trusted Web Activity) domain verification: /.well-known/assetlinks.json
app.use('/.well-known', express.static(path.join(rootDir, 'well-known'), { dotfiles: 'allow' }));
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const name = req.path === '/' ? 'index.html' : req.path.slice(1);
  if (!PUBLIC_ROOT_FILES.has(name)) return next();
  res.sendFile(name, { root: rootDir }, (err) => { if (err) next(); });
});

// Request Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ====================================================================
// API Endpoints
// ====================================================================

// Health Check & Database Status
app.get('/api/health', (req, res) => {
  const dbStatus = getDbStatus();
  res.json({
    status: 'healthy',
    service: 'СпаркСтоп Backend Engine',
    timestamp: new Date().toISOString(),
    database: dbStatus,
    quiet_hours: { window: describeQuietHours(), active: isQuietHours() }
  });
});

// Bulgarian Administrative Geo & Settlements Endpoints
app.get('/api/cities', getCitiesHandler);
app.get('/api/settlements/autocomplete', autocompleteSettlementHandler);
app.get('/api/addresses/autocomplete', autocompleteAddressHandler);
app.get('/api/geo/provinces', getProvincesHandler);
app.get('/api/geo/provinces/autocomplete', autocompleteProvincesHandler);
app.get('/api/geo/municipalities', getMunicipalitiesHandler);
app.get('/api/geo/municipalities/autocomplete', autocompleteMunicipalitiesHandler);
app.get('/api/geo/settlements', getSettlementsHandler);

// Official Exact Bulgaria Border GeoJSON
app.get('/api/geo/bulgaria-boundary', (req, res) => {
  const geoPath = path.join(rootDir, 'data', 'bulgaria_boundary.geojson');
  if (fs.existsSync(geoPath)) {
    res.setHeader('Content-Type', 'application/json');
    res.sendFile(geoPath);
  } else {
    res.status(404).json({ success: false, message: 'Boundary file not found' });
  }
});

// 0. User Authentication Endpoints
// POST /api/auth/register - Initiates registration and sends 6-digit email code
app.post('/api/auth/register', registerHandler);

// POST /api/auth/resend-code - New code for a registration already started (keeps the chosen password)
app.post('/api/auth/resend-code', resendRegistrationCodeHandler);

// GET /api/public-config - Public browser settings (the Turnstile site key is public by design; '' = check off)
app.get('/api/public-config', (req, res) => res.json({ success: true, turnstileSiteKey: getTurnstileSiteKey() }));

// POST /api/auth/verify-registration - Verifies 6-digit code and creates user
app.post('/api/auth/verify-registration', verifyRegistrationHandler);

// POST /api/auth/login - Authenticates with email & password
app.post('/api/auth/login', loginHandler);

// POST /api/auth/forgot-password - Sends 6-digit reset code
app.post('/api/auth/forgot-password', forgotPasswordHandler);

// POST /api/auth/reset-password - Verifies code and resets password
app.post('/api/auth/reset-password', resetPasswordHandler);

// GET /api/auth/me - Returns current authenticated user
app.get('/api/auth/me', getMeHandler);

// DELETE /api/auth/delete-account - Permanently deletes user and associated data
app.delete('/api/auth/delete-account', deleteAccountHandler);

// 1. Saved Addresses Endpoints
// POST /api/addresses/save - Validates and saves new address (strict limit of 3)
app.post('/api/addresses/save', saveAddressHandler);

// GET /api/addresses/verify-number - Soft plausibility check for a house number before saving
app.get('/api/addresses/verify-number', verifyHouseNumberHandler);

// GET /api/addresses/user/:userId - List saved addresses for user
app.get('/api/addresses/user/:userId', getUserAddressesHandler);

// DELETE /api/addresses/:id - Delete saved address
app.delete('/api/addresses/:id', deleteAddressHandler);

// PATCH /api/addresses/:id/notifications - Toggle push notifications for one saved address
app.patch('/api/addresses/:id/notifications', updateAddressNotificationHandler);

// GET /api/notifications/history/:userId - Past notifications for this user's addresses
app.get('/api/notifications/history/:userId', getNotificationHistoryHandler);

// POST /api/admin/notifications/test - Send one real push straight to an address's
// stored token and return Firebase's actual outcome (diagnostic tool, owner-only)
app.post('/api/admin/notifications/test', requireAdmin, sendTestNotificationHandler);

// 2. Outages & Live Map Endpoints
// GET /api/outages/check?street=...&city=... - Returns traffic light status (green/yellow/red) + countdown
app.get('/api/outages/check', checkOutageHandler);

// GET /api/outages/live-map - Returns active outages formatted with coordinates for Dark Mode map
app.get('/api/outages/live-map', liveMapHandler);

// 3. Scraper & Manual Triggers (owner-only — see requireAdmin above)
// POST /api/outages/trigger-scraper - On-demand trigger for scraping and AI parsing
app.post('/api/outages/trigger-scraper', requireAdmin, triggerScraperHandler);

// POST /api/outages/manual-add - Submit new outage with AI parser or raw object + push notification
app.post('/api/outages/manual-add', requireAdmin, manualAddOutageHandler);

// GET /api/admin/outages-table - Paginated/filterable outages browser
app.get('/api/admin/outages-table', requireAdmin, outagesTableHandler);

// POST /api/admin/rescan-provider - Restart a scrape for ONE provider only
// (the health panel's per-row restart button), instead of the full ~70-
// provider cycle. Fire-and-forget, same reasoning as trigger-scraper above —
// even a single-provider run still has real network+AI-parse latency.
app.post('/api/admin/rescan-provider', requireAdmin, (req, res) => {
  const { provider } = req.body || {};
  if (!provider || typeof provider !== 'string') {
    return res.status(400).json({ success: false, message: 'Няма посочен доставчик.' });
  }
  runScraperJob(false, provider).catch((err) => console.error(`❌ [RESCAN PROVIDER ERROR] ${provider}:`, err.message));
  res.status(202).json({ success: true, message: `Рестартирано сканиране за ${provider}.` });
});

// POST /api/admin/audit/dry-run - Kick off a full scrape cycle across every
// provider in PREVIEW mode: runs the exact same fetch/parse/match logic as
// a real scrape (runScraperJob), but never writes to outages — every
// genuinely new/missing outage found gets collected instead. Same
// fire-and-forget + poll pattern as url-health/source-audit (a full pass
// touches ~70 providers and can take several minutes); poll GET
// /api/admin/audit/dry-run for the result once it lands.
app.post('/api/admin/audit/dry-run', requireAdmin, (req, res) => {
  runDryRunAudit().catch((err) => console.error('❌ [DRY RUN AUDIT ERROR]', err.message));
  res.status(202).json({ success: true, message: 'Одитът стартира във фонов режим — може да отнеме няколко минути за всички доставчици.' });
});

// GET /api/admin/audit/dry-run - Latest dry-run result: every candidate
// outage found that doesn't already exist in the database, for an admin
// to review/select before anything goes live.
app.get('/api/admin/audit/dry-run', requireAdmin, (req, res) => {
  const state = getDryRunAuditState();
  if (!state.ranAt && !state.inProgress) {
    return res.status(202).json({ success: false, message: 'Все още няма направен одит. Стартирай го от бутона.' });
  }
  res.json({ success: true, data: state });
});

// POST /api/admin/commit-sync - Step 2 of the approval flow: the admin
// panel sends back exactly the candidates the admin checked in the modal
// (the full objects, not just ids — the frontend already holds them from
// the dry-run response, so no server-side batch cache/expiry is needed).
// Each one is written for real via the same upsertOutage() every live
// scraper uses, so it goes through the identical existing-row lookup and
// dedup constraint as any other write.
app.post('/api/admin/commit-sync', requireAdmin, async (req, res) => {
  const candidates = req.body?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return res.status(400).json({ success: false, message: 'Няма избрани записи за одобрение.' });
  }
  try {
    const result = await commitApprovedCandidates(candidates);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Manual entry for a provider whose site can't be scraped (blocked / down):
// GET lists the providers to choose from; POST previews what a pasted
// announcement would create — nothing is written until the admin approves it
// in the existing approval modal, which sends it to commit-sync above.
app.get('/api/admin/announcement-providers', requireAdmin, (req, res) => {
  res.json({ success: true, data: listManualAnnouncementProviders() });
});

app.post('/api/admin/announcement-preview', requireAdmin, async (req, res) => {
  try {
    const result = await previewManualAnnouncement(req.body || {});
    res.status(result.ok ? 200 : 400).json({ success: result.ok, data: result, message: result.message });
  } catch (err) {
    console.error('❌ [ANNOUNCEMENT PREVIEW ERROR]', err.message);
    res.status(500).json({ success: false, message: `Неуспешно разчитане на съобщението: ${err.message}` });
  }
});

// GET /api/admin/url-health - Latest known status of every official provider URL
// (checked at startup and once daily; never auto-modifies anything, purely reports)
app.get('/api/admin/url-health', requireAdmin, (req, res) => {
  const report = getLastUrlHealthReport();
  if (!report) {
    return res.status(202).json({ success: false, message: 'Проверката още не е приключила, опитай отново след малко.' });
  }
  res.json({ success: true, data: report });
});

// POST /api/admin/url-health/run - Kick off a fresh check in the background and return
// immediately (checking 39 URLs with retries can take longer than a typical proxy's
// request timeout); poll GET /api/admin/url-health for the result once it lands.
app.post('/api/admin/url-health/run', requireAdmin, (req, res) => {
  runUrlHealthCheck().catch((err) => console.error('❌ [URL HEALTH MANUAL RUN ERROR]', err.message));
  res.status(202).json({ success: true, message: 'Проверката стартира във фонов режим, изчакай малко и презареди.' });
});

// GET /api/admin/scraper-health - Per-provider found/parsed/saved counts from
// the last 48h of scrape cycles, plus which providers just regressed (were
// reliably finding outages, now suddenly returning 0/error). Distinct from
// url-health above: that only confirms a URL is reachable (HTTP 200) — this
// catches a reachable site whose content silently changed and now yields
// zero real outages, which is what actually broke Електрохолд/Софийска
// вода/ВиК Стара Загора before those were found and fixed.
app.get('/api/admin/scraper-health', requireAdmin, async (req, res) => {
  try {
    const summary = await getScraperHealthSummary();
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/ai-chat - Natural-language admin assistant. The AI only
// ever classifies a message into a small whitelisted action (see
// aiCommandChatService.js's ALLOWED_ACTIONS) — it never generates or runs
// SQL/code itself. A destructive action (delete_stale_outages) always comes
// back as a preview first; it only actually executes when the request
// carries back the exact `pending_action` this endpoint itself returned,
// plus `confirm: true` from the admin clicking the chat's own confirm
// button — never from re-interpreting a later free-text reply.
app.post('/api/admin/ai-chat', requireAdmin, async (req, res) => {
  try {
    const { message, pending_action: pendingAction, confirm, history } = req.body || {};

    if (pendingAction && confirm === true) {
      if (!pendingAction.action || typeof pendingAction.action !== 'string') {
        return res.status(400).json({ success: false, message: 'Невалидно действие за потвърждение.' });
      }
      const result = await executeAdminChatAction(pendingAction.action, pendingAction.params || {}, true);
      return res.json({ success: true, data: result });
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Съобщението е празно.' });
    }
    // Length cap — no legitimate admin question needs more than this; an
    // oversized payload here is either a mistake or someone probing for a
    // way to waste Gemini quota/tokens.
    if (message.length > 2000) {
      return res.status(400).json({ success: false, message: 'Съобщението е твърде дълго (макс. 2000 символа).' });
    }

    // history is only ever used as conversational context in the Gemini
    // prompt (classifyAdminChatMessage), never re-executed — capped here
    // too, defensively, independent of whatever the frontend already caps.
    const safeHistory = Array.isArray(history)
      ? history.slice(-10).filter((h) => h && typeof h.text === 'string').map((h) => ({ role: h.role === 'user' ? 'user' : 'ai', text: h.text.slice(0, 500) }))
      : [];

    const classification = await classifyAdminChatMessage(message.trim(), safeHistory);
    if (classification.action === 'chat') {
      return res.json({ success: true, data: { type: 'result', summary: classification.reply || 'Кажи ми повече — с какво да помогна?', rows: [] } });
    }

    const result = await executeAdminChatAction(classification.action, classification.params || {}, false);
    return res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/source-audit - Latest cached full source-content audit report
// (fetches every provider's real page live and cross-checks dates/content —
// same scrape+filter code path as production, via scrapeProviderTargetItems)
app.get('/api/admin/source-audit', requireAdmin, (req, res) => {
  const report = getLastSourceAuditReport();
  if (!report.ranAt && !report.inProgress) {
    return res.status(202).json({ success: false, message: 'Все още няма направена проверка. Стартирай я от бутона.' });
  }
  res.json({ success: true, data: report });
});

// POST /api/admin/source-audit/run - Kick off a fresh full source-content audit
// in the background (61 providers, fetched live, can take a few minutes);
// poll GET /api/admin/source-audit for the result once it lands.
app.post('/api/admin/source-audit/run', requireAdmin, (req, res) => {
  runSourceContentAudit().catch((err) => console.error('❌ [SOURCE AUDIT MANUAL RUN ERROR]', err.message));
  res.status(202).json({ success: true, message: 'Проверката на източниците стартира във фонов режим, ще отнеме няколко минути.' });
});

// POST /api/admin/source-audit/suggest-fix - Asks Gemini to read the actual
// current code of the files responsible for this class of bug and suggest a
// minimal fix as plain text, for a human to review and apply by hand.
// Deliberately never writes to disk — the admin explicitly asked for
// suggestions to review, not automatic edits to a live, judged site.
app.post('/api/admin/source-audit/suggest-fix', requireAdmin, async (req, res) => {
  try {
    const { provider } = req.body || {};
    const report = getLastSourceAuditReport();
    const entry = (report.results || []).find((r) => r.provider === provider);
    if (!entry) {
      return res.status(404).json({ success: false, message: 'Няма намерен резултат за този доставчик в последния одит.' });
    }
    const suggestion = await suggestCodeFixForIssue(entry);
    res.json({ success: true, data: { suggestion } });
  } catch (err) {
    console.error('❌ [SUGGEST FIX ERROR]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/stats - Outage/user/address counts, DB mode, last scrape info
app.get('/api/admin/stats', requireAdmin, getStatsHandler);

// An unknown /api path is a JSON 404 (Express' default is an HTML "Cannot GET" page an API client cannot parse).
app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Няма такъв адрес.' }));

// Global Error Handler
app.use((err, req, res, next) => {
  // A request body that is not valid JSON is the caller's mistake: a plain 400, not a logged "unhandled error".
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: 'Невалидни данни в заявката.' });
  console.error('🚨 Unhandled Error:', err);
  // A malformed id (a Postgres "invalid input syntax for type uuid") is "not found", not a server fault.
  if (err && err.code === '22P02') return res.status(404).json({ success: false, error: 'Не е намерено.' });
  if (err && err.message === 'Not allowed by CORS') return res.status(403).json({ success: false, error: 'Забранен произход на заявката.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ success: false, error: 'Твърде голяма заявка.' });
  const status = err.statusCode || err.status || 500;
  // Database/library messages of a real server fault are logged above, never sent to the client.
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'Възникна вътрешна грешка в сървъра.' : (err.message || 'Невалидна заявка.')
  });
});

// ====================================================================
// Cron Job: Automated Scraper (Every 5 minutes)
// ====================================================================
const cronSchedule = process.env.SCRAPER_CRON_SCHEDULE || '*/5 * * * *';
console.log(`⏰ Scheduled automated utility scraper with cron: "${cronSchedule}"`);

// A full cycle can take longer than the cron interval — the AI parser's
// 3-model fallback chain (each with its own network round trip) retries per
// scraped item, and Gemini's free-tier quota/rate limits mean many of those
// retries are slow failures, not fast ones. Without this guard, the next
// cron tick fired anyway while the previous run was still going, and the
// two overlapping runs then competed for the exact same constrained
// resources (Gemini quota, the Nominatim 1-req/sec queue) — making both
// slower still, compounding the problem instead of just letting one run
// take longer. This was confirmed happening live: consecutive runs 5
// minutes apart with the first nowhere near finished.
let scraperJobInProgress = false;
async function runScraperJobGuarded(trigger) {
  if (scraperJobInProgress) {
    console.warn(`⏭️ [SCRAPER] Skipped ${trigger} — a previous scrape is still running (it's taking longer than the "${cronSchedule}" interval, most likely Gemini API retries). Skipping instead of overlapping.`);
    return;
  }
  scraperJobInProgress = true;
  try {
    const results = await runScraperJob();
    console.log(`✅ [${trigger}] Processed ${results.length} outages.`);
  } catch (err) {
    console.error(`❌ [${trigger} ERROR] Scraper job failed:`, err.message);
  } finally {
    scraperJobInProgress = false;
  }
}

cron.schedule(cronSchedule, () => {
  if (inQuietHours()) return;
  console.log(`\n⏰ [CRON TRIGGER] Executing scheduled scraper at ${new Date().toISOString()}...`);
  runScraperJobGuarded('CRON TRIGGER');
});

// ====================================================================
// Cron Job: Reminders — a push 24 h and 1 h before an announced outage starts and when it ends
// (see services/reminderService.js). Nothing is sent, and the database is not touched, between
// 23:00 and 06:00 Sofia time or during the quiet hours.
// ====================================================================
let reminderJobInProgress = false;
cron.schedule('*/5 * * * *', async () => {
  if (inQuietHours() || reminderJobInProgress) return;
  reminderJobInProgress = true;
  try {
    await runReminderJob();
  } catch (err) {
    console.error('❌ [REMINDER CRON ERROR]', err.message);
  } finally {
    reminderJobInProgress = false;
  }
});

// ====================================================================
// Cron Job: Daily URL Health Check (detection only — never auto-fixes)
// ====================================================================
// node-cron defaults to the process's system timezone when none is given —
// Render's containers run in UTC, so without this the "daily 6 AM check"
// actually fired at 08:00/09:00 Sofia time depending on DST, drifting by an
// hour every spring/autumn change. Low-impact (diagnostic-only, never
// auto-fixes anything) but worth being explicit about.
cron.schedule('0 6 * * *', () => {
  runUrlHealthCheck().catch((err) => console.error('❌ [URL HEALTH CRON ERROR]', err.message));
}, { timezone: 'Europe/Sofia' });

// ====================================================================
// Cron Job: Autonomous self-cleanup — every hour, permanently removes
// outages whose expected_end_time passed more than 6h ago. Fully hands-off
// per explicit admin request (was previously once/day with a 3-day window,
// which let a large backlog accumulate between runs).
// ====================================================================
cron.schedule('0 * * * *', () => {
  if (inQuietHours()) return;
  pruneOldOutages().catch((err) => console.error('❌ [OUTAGE PRUNE CRON ERROR]', err.message));
}, { timezone: 'Europe/Sofia' });

// ====================================================================
// Cron Job: Data integrity self-check — re-validates every live outage
// against the same "is this actually a real announcement" filter the
// scraper applies at ingest time, and auto-resolves anything that no
// longer passes. Catches records that slipped through before that filter
// existed, and any future tightening of the rule without needing a
// re-scrape. Runs every 20 minutes; also once at startup below.
// ====================================================================
cron.schedule('*/20 * * * *', () => {
  if (inQuietHours()) return;
  runDataIntegritySweep().catch((err) => console.error('❌ [DATA INTEGRITY SWEEP CRON ERROR]', err.message));
});

// ====================================================================
// Start Server
// ====================================================================
app.listen(PORT, () => {
  console.log(`
╔═════════════════════════════════════════════════════════════════╗
║                      ⚡ СПАРКСТОП BACKEND ⚡                     ║
║   Real-time Outage Tracking & Push Alert Engine for Bulgaria    ║
╠═════════════════════════════════════════════════════════════════╣
║  🚀 Server running at: http://localhost:${PORT}                   ║
║  📡 API Health Check:  http://localhost:${PORT}/api/health        ║
║  🗺️ Live Map API:      http://localhost:${PORT}/api/outages/live-map║
║  🚦 Address Check API: http://localhost:${PORT}/api/outages/check ║
╚═════════════════════════════════════════════════════════════════╝
  `);

  // Record which outgoing address provider requests currently use (shown as an
  // info card in the health panel) — at start and then every 30 minutes. It is
  // what decides whether the small providers' hosting accepts us, and there was
  // no way to see it.
  const recordEgress = async () => {
    if (inQuietHours()) return;
    const ip = await lookupEgressAddress();
    await recordScraperRun('Изходящ адрес на сървъра', {
      found: 0,
      error: ip ? `инфо: ${ip}${process.env.SCRAPER_PROXY_URL ? ' (през прокси)' : ' (директно, споделен адрес на хостинга)'}` : 'инфо: не можа да се определи'
    });
  };
  recordEgress().catch(() => {});
  setInterval(() => recordEgress().catch(() => {}), 30 * 60 * 1000).unref();

  // Build the live-map snapshot right away so the first visitor after a
  // deploy/restart gets the map from cache instead of waiting on a cold build.
  refreshLiveMapSnapshot().catch((err) => {
    console.warn('⚠️ Initial live-map build warning:', err.message);
  });

  // A restart inside the quiet hours (Render restarts the service now and then) starts none of the
  // jobs below; the first cron tick after the window catches up.
  if (!inQuietHours()) {
    // Run live scraper on server startup
    runScraperJobGuarded('STARTUP');

    // Check provider URL health on startup too, not just on the daily schedule
    runUrlHealthCheck().catch((err) => {
      console.warn('⚠️ Initial URL health check warning:', err.message);
    });

    // Run the data integrity sweep on startup too, not just every 20 minutes
    runDataIntegritySweep().catch((err) => {
      console.warn('⚠️ Initial data integrity sweep warning:', err.message);
    });

    // A deploy keeps the old instance running next to this one for a few minutes, and the old
    // one can still write a row this code has since labelled differently (a duplicate until the
    // next sweep). Sweep again 4 and 10 minutes after startup so such duplicates disappear within
    // minutes instead of waiting for the next 20-minute boundary.
    for (const minutes of [4, 10]) {
      setTimeout(() => {
        if (inQuietHours()) return;
        runDataIntegritySweep().catch((err) => console.warn('⚠️ Post-startup integrity sweep warning:', err.message));
      }, minutes * 60 * 1000).unref();
    }

    // Run the autonomous cleanup on startup too, not just on the hourly cron —
    // otherwise the admin panel's "last cleanup" shows nothing until the next
    // hour ticks over on every fresh deploy.
    pruneOldOutages().catch((err) => {
      console.warn('⚠️ Initial outage prune warning:', err.message);
    });
  }
});

export default app;
