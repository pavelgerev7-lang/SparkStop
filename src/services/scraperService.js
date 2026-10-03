// СпаркСтоп (SparkStop) — © 2026 Pavel Gerev. Created for the John Atanasov Award.
import axios from 'axios';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { parseOutageTextWithAI, parseOutageTextHeuristic, getBulgariaUtcOffsetHours, extractStreetsHeuristic, normalizeOutageLabels } from './aiParserService.js';
import { upsertOutage, findCachedParsedOutage, closeVanishedOutages } from './outageService.js';
import { cleanOutageAnnouncementText, isAnnouncementIndicatingNoOutage, containsOutageIndicatorKeyword } from '../utils/textCleaner.js';
import { diagnoseEmptyPage, pageSnippet } from '../utils/pageDiagnosis.js';
import { getSettlementCoordinates, expandAbbreviatedSettlementName } from './geocodingService.js';
import { query } from '../config/db.js';
import { directAgents } from '../utils/egress.js';
import { logAndRecordScraperStats, checkForScraperRegressions, recordScraperRun } from './scraperHealthService.js';

// Shared wrapper every scraper's own upsertOutage() call site uses — keeps
// the admin dry-run audit's "collect every genuinely NEW outage instead of
// writing it" behavior in exactly one place instead of repeating the same
// dryRun/candidates plumbing at all 9 call sites across this file. See
// upsertOutage() (outageService.js) for what 'new' vs 'update' means: only
// 'new' (no existing matching row at all) is a candidate a human needs to
// approve — an 'update' just refreshes an already-live outage's end time.
async function upsertOrCollect(payload, dryRun, dryRunCandidates) {
  const result = await upsertOutage(payload, { dryRun });
  // Never surface an already-resolved candidate for admin review — some
  // provider sites still list old archived announcements (confirmed live:
  // a 2006 Севлиевогаз bulletin, a 2023 Ситигаз one) that genuinely were
  // never saved before, so upsertOutage() correctly calls them 'new'. But
  // their own expected_end_time is already in the past, so status computes
  // to 'resolved' — approving one would insert a row invisible on the live
  // map (which only ever shows active/scheduled) that the hourly autonomous
  // cleanup would delete again within the hour anyway. Reviewing dozens of
  // these by hand was pure wasted admin time for zero actual effect.
  if (dryRun && result && result.action === 'new' && result.status !== 'resolved' && dryRunCandidates) {
    dryRunCandidates.push(result);
  }
  return result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simple vertex-average centroid of an ArcGIS esriGeometryPolygon's first
// ring — good enough to place a single marker solidly inside an ordinary
// municipal outage zone (not a mathematically exact area-weighted
// centroid, which isn't needed here). Requires geometry already
// reprojected to WGS84 (outSR=4326 on the query) — a raw projected-CRS
// polygon would produce nonsense here. Returns null (never a guessed
// point) for anything malformed or landing outside Bulgaria's own rough
// bounding box, so a bad/empty geometry always falls through to the
// caller's normal text-based geocoding instead of a silently wrong pin.
function computePolygonRingCentroid(geometry) {
  const ring = geometry?.rings?.[0];
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let sumLng = 0, sumLat = 0, count = 0;
  for (const point of ring) {
    if (!Array.isArray(point) || point.length < 2) continue;
    sumLng += point[0];
    sumLat += point[1];
    count++;
  }
  if (count === 0) return null;
  const lng = sumLng / count;
  const lat = sumLat / count;
  if (lat < 41 || lat > 44.5 || lng < 22 || lng > 29) return null;
  return { lat, lng };
}

// Resource-saving throttle requested explicitly: 1.5s between successive
// outbound calls to an external provider site AND between successive real
// Gemini calls (never between cache hits — findCachedParsedOutage() above
// already skips the AI call entirely for unchanged text, so there's
// nothing to pace there). Kept as one small shared delay rather than
// separate constants since both exist for the identical reason — avoid
// bursting a rate limit — and tuning them together if the value ever
// changes is simpler with one source of truth.
const THROTTLE_DELAY_MS = 1500;

// Batch processing: every BATCH_SIZE real AI parse calls across a full
// scrape cycle, take a longer cool-down pause on top of the normal
// per-call throttle above — extra headroom for the (rare, since most
// providers return well under this many items) case where a single cycle
// needs an unusually large number of fresh parses. Module-level counter:
// intentionally spans the WHOLE cycle (all providers), not reset per
// provider, since the actual rate-limit budget being protected is
// per-API-key, not per-provider.
const BATCH_SIZE = 50;
const BATCH_PAUSE_MS = 8000;
let aiParseCallsThisCycle = 0;

async function throttledAiParse(text, provider, city, sourceUrl) {
  const cached = await findCachedParsedOutage(provider, city, text);
  if (cached) return normalizeOutageLabels(cached, city);

  aiParseCallsThisCycle++;
  if (aiParseCallsThisCycle > 1) await sleep(THROTTLE_DELAY_MS);
  if (aiParseCallsThisCycle % BATCH_SIZE === 0) {
    console.log(`⏸️ [THROTTLE] ${aiParseCallsThisCycle} AI parse calls this cycle — batch cool-down (${BATCH_PAUSE_MS / 1000}s)...`);
    await sleep(BATCH_PAUSE_MS);
  }
  return parseOutageTextWithAI(text, provider, city, sourceUrl);
}

// Builds a stable identity fingerprint for a scraped item that has neither a
// real href nor an id (used as the tail of a synthetic sourceUrl, which in
// turn becomes source_announcement_key — see the call site in
// scrapeProviderTargetItems()). Exported as a pure function (no cheerio/$
// state) specifically so this can be unit-tested directly.
//
// CONFIRMED LIVE (ВиК Русе, 2026-09-20): slicing the item's raw, unmodified
// text starts with its OWN leading "DD.MM HH:MM - DD.MM HH:MM" schedule
// (vik-ruse.com's own widget markup) — exactly the part of the text that
// legitimately CHANGES as a single real, ongoing outage's own window
// narrows or gets marked "завършен" on a later re-scrape. Since this
// fingerprint becomes source_announcement_key, and matchesOutage() in
// upsertOutage() trusts a present key EXCLUSIVELY (skipping the street/date
// fallback entirely once both sides have one), a changed fingerprint made
// the SAME real outage look like a brand-new announcement every time its
// schedule/status text updated — permanently orphaning the earlier row
// (still 'active', with the stale end time) instead of updating it, while
// ALSO inserting a fresh duplicate 'resolved' row (which then had no dedup
// protection at all — see upsertOutage()'s existingResolved check) on every
// subsequent scrape for as long as the source kept re-listing the
// now-finished item. Reproduced live: one Червена вода outage produced 16
// duplicate resolved rows in under 3 hours this way.
//
// Fixed by preferring the page's own semantic address element when one
// exists (vik-ruse.com's <span class="address">) — the one part of the item
// that IS the outage's actual stable identity — and otherwise stripping the
// volatile leading date range + any resolved-status word before slicing, so
// the fingerprint stays anchored on content that doesn't change across an
// ordinary status update. Kept as a fallback (not a replacement) for
// Кюстендилска вода's 37 no-href/no-id entries, which this still tells
// apart exactly as before (their content differs beyond just the date/
// status, so it still slices to distinct fingerprints).
export function buildItemFingerprint(addressText, fullElementText) {
  const cleanAddress = (addressText || '').replace(/\s+/g, ' ').trim();
  const fingerprintBase = cleanAddress || (fullElementText || '').replace(/\s+/g, ' ').trim()
    .replace(/^\(?\d{1,2}[.:]\d{1,2}(?:\s+\d{1,2}[:.]\d{2})?\s*[-–—]\s*\d{1,2}[.:]\d{1,2}(?:\s+\d{1,2}[:.]\d{2})?\)?:?\s*/, '')
    .replace(/(?:^|[^а-яa-z])(?:завършен|отстранен|приключен)[а-я]*(?:$|[^а-я])/gi, ' ');
  return fingerprintBase.slice(0, 60);
}

// Per-provider circuit breaker + last-failure note for the generic
// PROVIDER_TARGETS loop. Confirmed live (2026-09-23): ~21 providers that had
// been returning items for days all dropped to 0 in the same minutes on the
// production server while every one of them still answered normally from a
// different IP — most of them sit in just two Bulgarian hosting networks
// (185.45.64.x / 91.196.124.x), i.e. a firewall blocking this server's own
// address, not a scraper bug. Two problems made that worse and invisible:
// (1) a blocked site was retried on every cycle (each attempt burning the
// fetchWithRetry backoff, delaying every provider behind it, and giving the
// host's firewall more reason to keep the block), and (2) the reason was only
// console.warn'ed, so the health panel just showed a bare red "0" with no
// trace of WHY. After 3 consecutive block-like failures (refused/reset/
// timeout/403/429/5xx) a provider now pauses for 30 min, doubling up to 6h
// while it keeps failing, and the reason is stored in scraper_run_stats.error.
const scrapeFailureState = new Map(); // provider -> { fails, skipUntil, lastError }
const lastScrapeNote = new Map(); // provider -> text to store as this run's `error`
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Honest identity, used for providers we have asked (or are about to ask) to
// allow our server: Топлофикация Бургас and Топлофикация Русе refuse it, so
// there is nothing to lose there, and a provider that agrees can allow-list
// this exact string. Explained at /bot.html. Not used for sites that work
// today — some of them do reject an unrecognised user agent (see the note on
// Strategy B's article fetch), so those keep the browser one.
export const SPARKSTOP_BOT_UA = 'SparkStopBot/1.0 (+https://sparkstopapp.com/bot.html; contact@sparkstopapp.com)';

// Request headers for a target's page and follow-up fetches. An identified
// bot doesn't claim to arrive from a Google search, so it gets no Referer.
function buildRequestHeaders(target) {
  if (target.userAgent) {
    return {
      'User-Agent': target.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'bg-BG,bg;q=0.9,en;q=0.5'
    };
  }
  return {
    'User-Agent': BROWSER_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'bg-BG,bg;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://www.google.com/'
  };
}

// Why the most recent scrapeProviderTargetItems() call for a provider found
// nothing / failed (null when there is nothing to report).
export function getLastScrapeNote(provider) {
  return lastScrapeNote.get(provider) || null;
}
const BLOCK_LIKE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH']);
const FAILS_BEFORE_COOLDOWN = 3;
const BASE_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function isBlockLikeError(err) {
  const status = err?.response?.status;
  return BLOCK_LIKE_CODES.has(err?.code) || status === 403 || status === 429 || (typeof status === 'number' && status >= 500);
}

// A refusing server's Retry-After header ("3600" seconds, or an HTTP date) as
// milliseconds from now; 0 when absent/unparseable. Honoured below so a host
// that asked us to stay away for an hour is not asked again after 10 minutes.
export function parseRetryAfterMs(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return 0;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Math.max(0, parseInt(text, 10) * 1000);
  const at = Date.parse(text);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}

// Short description of a refusing server's answer: which server/CDN, any
// Retry-After, and the first words of its error page.
function describeRefusal(response) {
  const h = response.headers || {};
  const parts = [];
  if (h.server) parts.push(`server=${String(h.server).slice(0, 30)}`);
  if (h['cf-ray']) parts.push('cloudflare');
  if (h['retry-after']) parts.push(`retry-after=${String(h['retry-after']).slice(0, 20)}`);
  const body = typeof response.data === 'string' ? response.data : '';
  const text = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, ' ').replace(/\s+/g, ' ').trim();
  if (text) parts.push(`"${text.slice(0, 80)}"`);
  return parts.join(', ');
}

// Retry wrapper for the generic PROVIDER_TARGETS fetch (the single call
// site covering all 63 generic providers) — confirmed live earlier this
// session that 0/63 providers were actually blocked by headers/WAF right
// now, so this isn't fixing an active problem, but a transient blip (a
// momentary 500, a rate-limit 429, a dropped connection) on any one of 63
// real network calls every scrape cycle is still a realistic, ordinary
// failure mode worth not giving up on immediately. Only retries responses
// that look transient — a clean 404 (the page genuinely doesn't exist) or
// a DNS failure won't fix itself by waiting, so those fail fast instead of
// wasting 3 cycles of backoff on something retrying can't help.
async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await axios.get(url, options);
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      // 403 is deliberately NOT retried: it is an explicit "no", and three more
      // requests with backoff only add load to a host that just refused us.
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

/**
 * List of Utility Providers across Bulgaria to Scrape & Monitor
 * Covers all 3 Electricity Distribution Operators (Електрохолд, EVN, ЕРП Север)
 * and regional Water Utilities (ВиК) and District Heating (Топлофикация)
 */
export const PROVIDER_TARGETS = [
  // 1. София & София-област
  // Софийска вода's outages are fully covered by the dedicated
  // scrapeSofiaWaterGis() below, which now queries BOTH of the provider's
  // own ArcGIS layers (current AND planned stoppages — the old version
  // here only ever saw the homepage's generic news text, which doesn't
  // list either).
  // Електрохолд's ENTIRE 10-province ЕРМ Запад territory (София,
  // София-област, Благоевград, Перник, Враца, Плевен, Ловеч, Монтана,
  // Видин, Кюстендил) is now fully covered by the dedicated
  // scrapeElektroholdLivePower() below, via info.ermzapad.bg's real
  // outage-map endpoint. This entry used to point at
  // ermzapad.bg/bg/za-klienta/prekusvania/ — confirmed live, that's a
  // static marketing landing page with two outbound buttons and NO outage
  // data of its own (the raw HTML doesn't contain the word "София" — or
  // any settlement name — anywhere), so every generic selector tried here
  // only ever matched nav/footer boilerplate ("Намерете ни", "Пишете
  // ни"...). This is why Sofia (and every other ЕРМ Запад province)
  // showed near-zero Електрохолд outages despite real active ones
  // existing on the provider's own site.
  // Топлофикация София's outages are fully covered by the dedicated
  // scrapeSofiaHeatingToplo() below via toplo.bg's own embedded structured
  // JSON feed (exact ISO dates, no free-text scraping needed) — the old
  // entry here pointed at the bare homepage (no outage listing at all) and
  // used generic free-text scraping, which is why Sofia's heating outages
  // were severely under-reported.
  // 2. Пловдив — EVN България's outages here are already fully covered by
  // scrapeElYugLivePower() (dedicated per-region URL + real region scoping),
  // which runs before this loop. A generic entry pointing at the same shared
  // elyug.bg page under a hardcoded city guess only risked re-inserting the
  // same outages tagged with the wrong one of several possible cities.
  {
    provider: 'ВиК Пловдив',
    city: 'Пловдив',
    url: 'https://vik.bg/avarii/',
    selector: '.outage-item, .news-item, p',
    defaultUtility: 'water'
  },
  // The old url here (evn.bg/Toplo/Outages) was a guess that 404s (soft-404
  // "EVN - NotFound" title, HTTP 200) — confirmed live it never returned
  // real content. Pointed at the real page instead
  // (evn.bg/Home/Heating.aspx), but confirmed that page ALSO has no public
  // outage list/feed at all — its "При аварии" section is just static
  // hotline/pricing guidance for reporting a heating emergency by phone,
  // not a bulletin of current incidents. Kept the entry (harmless — the
  // keyword filter correctly finds nothing to scrape here) since EVN
  // Топлофикация genuinely doesn't appear to publish this data publicly,
  // unlike every other heating/water/electricity provider covered here.
  {
    provider: 'EVN Топлофикация',
    city: 'Пловдив',
    url: 'https://www.evn.bg/Home/Heating.aspx',
    selector: '.toplo-outage, p',
    defaultUtility: 'heating'
  },
  // 3. Варна — Енерго-Про outages already covered by scrapeErpSeverLivePower()
  // (dedicated per-region API call), which runs before this loop.
  {
    // Was the bare homepage — confirmed live it has zero outage content;
    // real current outages (today-dated, real streets/settlements) sit on
    // this dedicated page instead, as <div class="list-item"> blocks with
    // no selector this scraper previously recognized.
    provider: 'ВиК Варна',
    city: 'Варна',
    url: 'https://vikvarna.com/bg/messages/breakdown.html',
    selector: '.list-item, .news-content, .news-item, p',
    defaultUtility: 'water'
  },
  // 4. Бургас — EVN България already covered by scrapeElYugLivePower().
  {
    // Was the bare homepage — confirmed live it has zero outage content.
    // Real current repairs (today-dated, real streets/complexes) sit on
    // this dedicated per-district page instead — the title (with the
    // keyword and date) and the actual location list are separate DOM
    // nodes wrapped by .vik-page-body, so that's the selector that needs
    // to match, not either piece alone.
    provider: 'ВиК Бургас',
    city: 'Бургас',
    url: 'https://vik-burgas.com/current-repairments/Rajon-Burgas/',
    selector: '.vik-page-body, .outage-list, article, p',
    defaultUtility: 'water'
  },
  // 5. Русе — Енерго-Про already covered by scrapeErpSeverLivePower().
  {
    provider: 'ВиК Русе',
    city: 'Русе',
    url: 'https://vik-ruse.com',
    selector: '.outage-item, article, p',
    defaultUtility: 'water'
  },
  // 6. Стара Загора — EVN България already covered by scrapeElYugLivePower().
  // ВиК Стара Загора's outages are fully covered by the dedicated
  // scrapeStaraZagoraWaterLive() below — this entry used to point at the
  // bare corporate homepage (wik-stz.com), which has no outage listing at
  // all; the real, currently-updated log lives on a completely separate
  // subdomain (avarii.wik-stz.com), same architectural gap already found
  // for Електрохолд and ВиК Ямбол.
  // 7. Велико Търново — Енерго-Про already covered by scrapeErpSeverLivePower().
  {
    provider: 'ВиК Йовковци',
    city: 'Велико Търново',
    url: 'https://www.vik-vt.com',
    selector: '.news-block, article, a, p',
    defaultUtility: 'water'
  },
  // 8. Шумен — Енерго-Про already covered by scrapeErpSeverLivePower().
  {
    provider: 'ВиК Шумен',
    city: 'Шумен',
    url: 'https://www.vik-shumen.net',
    selector: '.et_pb_post, article, p',
    defaultUtility: 'water'
  },
  {
    // /avarii 404s now (confirmed live) — the site restructured and moved
    // outage announcements straight onto the homepage under "Новини".
    provider: 'ВиК Плевен',
    city: 'Плевен',
    url: 'https://vik-pleven.com/',
    selector: '.news-item, p',
    defaultUtility: 'water'
  },
  // 9. Благоевград (Електрохолд covered by the single consolidated entry above)
  {
    provider: 'ВиК Благоевград',
    city: 'Благоевград',
    url: 'http://vikblg.com/',
    selector: '.news-item, p',
    defaultUtility: 'water'
  },
  // 10. Сливен
  // 10. Сливен — EVN България already covered by scrapeElYugLivePower().
  {
    provider: 'ВиК Сливен',
    city: 'Сливен',
    url: 'https://vik.sliven.net/',
    selector: '.news-item, p',
    defaultUtility: 'water'
  },
  // 11. Добрич — Енерго-Про already covered by scrapeErpSeverLivePower().
  {
    // Was the bare homepage — confirmed live it has zero outage content;
    // real today-dated outages sit on this dedicated page instead.
    provider: 'ВиК Добрич',
    city: 'Добрич',
    url: 'https://vikdobrich.bg/Info/BreakdownIndex',
    selector: '.news-text, .news-item, p',
    // One province-wide list of "- Район X: …" lines — see splitRegionItems().
    splitRegions: true,
    defaultUtility: 'water'
  },
  // 13. Перник (Електрохолд covered by the single consolidated entry above)
  {
    // /avarii 404s now (confirmed live) — the actual page moved to /repairs/.
    provider: 'ВиК Перник',
    city: 'Перник',
    url: 'https://vik-pernik.eu/repairs/',
    selector: '.news-item, p',
    defaultUtility: 'water'
  },
  // 14. Хасково — EVN България already covered by scrapeElYugLivePower().
  {
    provider: 'ВиК Хасково',
    city: 'Хасково',
    url: 'https://vikhaskovo.bg/',
    selector: '.news-item, p',
    defaultUtility: 'water'
  },
  // 15. Пазарджик — EVN България already covered by scrapeElYugLivePower().
  {
    provider: 'ВиК Пазарджик',
    city: 'Пазарджик',
    url: 'https://vikpz.com/%D0%B0%D0%B2%D0%B0%D1%80%D0%B8%D0%B8/',
    selector: '.news-item, p',
    defaultUtility: 'water'
  },
  // 16. Габрово — Енерго-Про's outages here (and across all 9 Northern
  // provinces) are fully covered by the dedicated scrapeErpSeverLivePower()
  // below via erpsever.bg's own XHR API. This entry pointed at the generic
  // /planirani-prekysvaniq page with a weak selector and consistently found
  // 0 — harmless on its own, but it recorded scraper-health stats under the
  // EXACT SAME provider name as the dedicated (223-items-healthy) scraper,
  // which made the health-regression checker see a false "just broke"
  // alert on a perfectly working provider every single run. Removed rather
  // than renamed, matching Софийска вода/Електрохолд/ВиК Стара Загора above.
  {
    // /avarii 404s now (confirmed live) — the actual page moved to /avarii-i-remonti.
    provider: 'ВиК Габрово',
    city: 'Габрово',
    url: 'https://vik-gabrovo.com/avarii-i-remonti',
    selector: '.news-item, p',
    defaultUtility: 'water'
  },
  // 17. Враца (Електрохолд covered by the single consolidated entry above)
  {
    provider: 'ВиК Враца',
    city: 'Враца',
    // Was the bare homepage — Strategy A/C's text scrape grabbed the whole
    // page (nav menu, "About us" links, footer) concatenated together as if
    // it were one outage announcement. This dedicated "Аварии и ремонт"
    // section at least limits it to real outage headlines (each one still
    // needs Strategy B to actually follow its own "научи повече тук" link
    // for real per-item detail — see the widened link-text match below).
    url: 'https://vik-vratza.eu/info?info=ViKavarii',
    selector: '.news-item, p',
    itemLimit: 6,
    defaultUtility: 'water'
  },
  // 18-27. Previously-missing provincial ВиК operators — every one of these
  // URLs was confirmed live (200 OK) before adding, following the same
  // "verify before hardcoding" approach as the fixes elsewhere in this file.
  {
    provider: 'ВиК Видин',
    city: 'Видин',
    url: 'https://vik-vidin.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    provider: 'Кюстендилска вода',
    city: 'Кюстендил',
    // Was the homepage — its own real outage list lives entirely inside an
    // <iframe src="https://avarii.kyustendilskavoda.com/index.php">, never
    // present in the homepage's own HTML at all (an iframe's content is a
    // separate document a plain HTML fetch never follows). Confirmed live:
    // the iframe's own page reports "Общо 37 събития" and structures each
    // one as a plain <article> — already matched by Strategy A's selector,
    // once pointed at the actual content instead of its wrapper page.
    url: 'https://avarii.kyustendilskavoda.com/index.php',
    selector: '.news-item, article, p',
    defaultUtility: 'water',
    // Confirmed live via the GIS/network-request sweep below: this page's
    // own sidebar reports "Общо 44 събития" (44 total events), well above
    // the old cap of 20 — silently dropping the older half of the list on
    // every scrape.
    itemLimit: 50
  },
  {
    provider: 'ВиК Монтана',
    city: 'Монтана',
    url: 'https://vikmontana.com/bg/messages.html',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    provider: 'ВиК Ловеч',
    city: 'Ловеч',
    url: 'https://www.wss-lovech.bg/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    provider: 'Водоснабдяване-Дунав',
    city: 'Разград',
    url: 'http://dunav-rz.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    provider: 'ВиК Силистра',
    city: 'Силистра',
    url: 'https://vik-silistra.com/водопроводна-авария/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    provider: 'ВиК Смолян',
    city: 'Смолян',
    url: 'https://www.vik-smolyan.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    // The site's own Cyrillic-slug URL 404s — confirmed live: their current
    // WordPress config generates a garbled hex-dash slug for this page
    // instead of a proper URL-encoded one, so this is the actual working
    // address, found via the "Аварии и ремонти" link on their homepage.
    provider: 'ВиК Ямбол',
    city: 'Ямбол',
    url: 'https://vik-yambol.bg/d0-b0-d0-b2-d0-b0-d1-80-d0-b8-d0-b8-d0-b8-d1-80-d0-b5-d0-bc-d0-be-d0-bd-d1-82-d0-b8/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    provider: 'ВиК Търговище',
    city: 'Търговище',
    url: 'http://viktg.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    provider: 'ВиК Кърджали',
    city: 'Кърджали',
    url: 'https://vik-kardzhali.com/avarii-remont/latest',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  // 28-36. Smaller-municipality ВиК operators that run separately from their
  // own province's main operator (confirmed via the Union of ВиК Operators'
  // full 47-member list — Bulgaria has more water operators than provinces,
  // since several municipalities kept their own instead of joining the
  // regional consolidated one). Every URL confirmed reachable before adding.
  // ВиК Дупница, ВиК Ракитово and ВиК Стрелча were left out: Dupnitsa's
  // operator is in liquidation with its site taken down for unpaid hosting
  // (confirmed dead, not just a broken link), and Rakitovo/Strelcha have no
  // dedicated site at all to scrape.
  {
    provider: 'ВиК Петрич',
    city: 'Петрич',
    url: 'https://vik-petrich.eu/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    provider: 'Увекс (ВиК Сандански)',
    city: 'Сандански',
    url: 'https://www.uvexbg.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    provider: 'ВиК Кресна',
    city: 'Кресна',
    url: 'https://kresna-bg.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    provider: 'ВиК Берковица',
    city: 'Берковица',
    url: 'https://vik-berkovica.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    provider: 'ВиК Стенето (Троян)',
    city: 'Троян',
    url: 'https://viktroyan.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  // ВиК Велинград (vikvelingrad.com) is no longer a source: the domain has
  // expired (a GoDaddy parking page that redirects every path to /lander), and
  // Велинград is now served by ВиК Пазарджик, whose own "Аварии" page lists
  // Велинград's outages — already scraped above (2026-09-24: e.g. "ул. Еленка,
  // ул. Баба Тонка, ул. Сокол в гр. Велинград"). Removed instead of being left
  // to report a permanent warning.
  {
    provider: 'ВиК Панагюрище',
    city: 'Панагюрище',
    url: 'https://vik-pan.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    provider: 'ВиК Пещера',
    city: 'Пещера',
    url: 'https://www.vks-peshtera.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    provider: 'ВиК Исперих',
    city: 'Исперих',
    url: 'https://vikisperih.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    // Bratsigovo's actual water/sewage operator is "Инфрастрой" ЕООД, not a
    // "ВиК Брацигово"-named company.
    provider: 'Инфрастрой (ВиК Брацигово)',
    city: 'Брацигово',
    url: 'https://infrastroi-eood.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'water'
  },
  {
    // Serves 22 municipalities across Sofia province (outside Sofia city
    // itself, which stays on Софийска вода above). Was the bare homepage —
    // Strategy A/C's text scrape grabbed the ENTIRE page (huge nav menu,
    // "About us" links, footer) as one blob, with the real embedded outage
    // list buried and un-attributable to any specific time/street. This
    // dedicated archive page instead exposes each incident as its own
    // <article class="... accident ..."> with clean inline region/street/
    // deadline text, which Strategy A's own "article" selector already
    // picks up as separate items — itemLimit raised since this single page
    // covers all 22 served municipalities at once (same reasoning as
    // Електрохолд's consolidated entry above).
    provider: 'ВиК София област',
    city: 'Костинброд',
    // Confirmed live: the per-item upsert loop's own region fallback
    // (region: structuredOutage.region || target.city, further down in this
    // file) used target.city ("Костинброд" — this provider's own default/HQ
    // town) as the region for EVERY one of its 22 served municipalities,
    // since the AI/heuristic parser doesn't extract a real region from
    // these bulletins itself. "Костинброд" matches nothing in the 5,265-
    // settlement registry's own region field (a real province, e.g.
    // "София-град" — confirmed against the registry: every one of this
    // provider's municipalities, Ботевград/Елин Пелин/Самоков/Правец/
    // Златица/Костинброд itself, is filed under exactly that value there).
    // That meant EVERY village this provider reports — not just ones hit by
    // the separate text-gluing bug — failed the region-constrained
    // settlement lookup outright and fell back to Sofia's own coordinate.
    // Explicit target.region overrides the target.city fallback for exactly
    // this case without changing behavior for any other provider (none of
    // which set this field).
    region: 'София-град',
    url: 'https://viksofbg.com/avarii/',
    selector: '.news-item, article, p',
    itemLimit: 15,
    defaultUtility: 'water'
  },
  // Additional District Heating (Топлофикация) operators
  {
    provider: 'Топлофикация Сливен',
    city: 'Сливен',
    url: 'https://toplo.sliven.net/',
    selector: '.news-item, article, p',
    defaultUtility: 'heating',
    // The page's own link to its outage list is on the company's other domain.
    followHosts: ['toplosliven.com']
  },
  {
    provider: 'Топлофикация Габрово',
    city: 'Габрово',
    url: 'https://www.toplo-gb.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'heating'
  },
  {
    provider: 'Топлофикация Враца',
    city: 'Враца',
    url: 'https://toplo-vr.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'heating',
    // Big city whose site refuses us at times: try again EVERY cycle (one
    // request, no in-cycle retries, no growing pauses) so it is picked up as
    // soon as it lets us in. A Retry-After the site sends is still honoured.
    probeEveryCycle: true,
    noProxy: true
  },
  {
    // Confirmed missing entirely — a user reported a real, currently active
    // Перник heating outage (dozens of named blocks + several schools/
    // kindergartens) that never showed up anywhere in the app, and this
    // turned out to be why: this provider had no PROVIDER_TARGETS entry at
    // all, so the scraper never even attempted to check its site, let alone
    // find or filter anything on it. Their WHOLE homepage is itself wrapped
    // in one giant <article> (phone numbers, menus, footer and all), so
    // Strategy A alone grabs that entire blob starting from the nav/contact
    // boilerplate instead of any specific announcement — the homepage's own
    // "Последни аварии и ремонти" section links ("Авария- DD.MM.YYYY г.")
    // to real per-incident pages are what Strategy B needs to follow
    // instead (see the "Авария" link-text match added alongside this).
    provider: 'Топлофикация Перник',
    city: 'Перник',
    url: 'https://toplo-pernik.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'heating'
  },
  {
    // Also confirmed missing entirely, found in the same sweep — a real,
    // reachable site (toplo-ruse.com) with no PROVIDER_TARGETS entry.
    provider: 'Топлофикация Русе',
    city: 'Русе',
    url: 'https://toplo-ruse.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'heating',
    // Their Cloudflare challenge refuses our server; identify ourselves
    // honestly (see SPARKSTOP_BOT_UA) so they can allow us by name. Big city:
    // tried again every cycle (see Топлофикация Враца's probeEveryCycle).
    // noProxy: an explicit refusal is never worked around through another address.
    userAgent: SPARKSTOP_BOT_UA,
    probeEveryCycle: true,
    noProxy: true
  },
  {
    provider: 'Топлофикация Велико Търново',
    city: 'Велико Търново',
    url: 'https://www.toplo-vt.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'heating'
  },
  {
    // A THIRD entirely-missing heating provider, caught only because a
    // second, more careful pass through the same phantom-provider sweep
    // caught a mistake in the first pass: "Топлофикация Бургас" looked
    // covered because a text match turned up around this area of the file
    // — but that match was SAMPLE_BULGARIAN_ANNOUNCEMENTS test fixture
    // data (a { text: ... } fixture for testing the AI parser), not a real
    // { url, selector } PROVIDER_TARGETS entry. Confirmed live: the real
    // site has a dedicated "Аварии" page with genuine dated incidents
    // ("Авария 03.09.2026", "Отстраняване на авария в к.с. Зорница").
    provider: 'Топлофикация Бургас',
    city: 'Бургас',
    url: 'https://toplo-bs.com/аварии/',
    selector: '.news-item, article, p',
    defaultUtility: 'heating',
    // Their firewall limits our server's access; identify ourselves honestly
    // (see SPARKSTOP_BOT_UA) so they can allow us by name. Big city: tried
    // again every cycle (see Топлофикация Враца's probeEveryCycle) — except
    // that their Retry-After (1 h) is honoured.
    // noProxy: an explicit refusal is never worked around through another address.
    userAgent: SPARKSTOP_BOT_UA,
    probeEveryCycle: true,
    noProxy: true
  },
  {
    // Varna's district heating operator trades under the Veolia brand, not
    // "Топлофикация Варна" — that's why it was missed on the first pass.
    // timeout raised — confirmed live this site isn't blocked, it just
    // routinely takes 10-15s to respond, well past the default 8s.
    provider: 'Веолия Енерджи Варна',
    city: 'Варна',
    url: 'https://energy-varna.bg/',
    selector: '.news-item, article, p',
    defaultUtility: 'heating',
    timeout: 20000
  },
  {
    // The www. subdomain doesn't resolve (confirmed) but the bare domain
    // does — this company genuinely has a working site, it just looked
    // unreachable on the first check because of that.
    provider: 'Топлофикация Разград',
    city: 'Разград',
    url: 'https://toplo-razgrad.bg/',
    selector: '.news-item, article, p',
    defaultUtility: 'heating'
  },
  {
    // Licensed final electricity supplier for the Golden Sands resort's own
    // low-voltage network — a genuine small network, not a market trader.
    provider: 'ЕСП Златни пясъци',
    city: 'Варна',
    url: 'https://esp-zlatni.bg/',
    selector: '.news-item, article, p',
    defaultUtility: 'electricity'
  },
  // Additional Natural Gas (Газ) distribution operators — each licensed for
  // a specific municipality, distinct from the nationwide Overgas GIS feed.
  {
    provider: 'Севлиевогаз-2000',
    city: 'Севлиево',
    url: 'https://sevlievogas.eu/',
    selector: '.news-item, article, p',
    defaultUtility: 'gas'
  },
  {
    provider: 'Черноморска газова компания',
    city: 'Варна',
    url: 'https://www.bsgc.bg/',
    selector: '.news-item, article, p',
    defaultUtility: 'gas'
  },
  {
    provider: 'Примагаз',
    city: 'Варна',
    url: 'https://primagas-bg.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'gas'
  },
  {
    // Covers 42 municipalities across Тракия (Пловдив/Хасково/Казанлък/
    // Чирпан/Кърджали), Силистра and Габрово — previously had NO real
    // scraper target at all; its announcements were silently going through
    // the generic Overgas fallback link instead of its own site.
    provider: 'Ситигаз България',
    city: 'Пловдив',
    url: 'https://xn--80afnba6ci.xn--90ae/',
    selector: '.news-item, article, p',
    defaultUtility: 'gas',
    itemLimit: 10,
    // Unlike ВиК София област (same multi-municipality shape, fixed above
    // with an explicit single target.region), this provider's own coverage
    // spans FIVE different real provinces — there's no one correct region
    // value to hardcode here without wrongly mislabeling whichever villages
    // AREN'T in Пловдив. regionUnknown skips the target.city region
    // fallback entirely for this target (see the upsert loop below), so an
    // outage from any of its other four provinces gets an unconstrained
    // settlement search instead of a confidently-wrong Пловдив-constrained
    // one that would fail for 4 of its 5 provinces and fall back to Sofia's
    // coordinate exactly like ВиК София област did.
    regionUnknown: true
  },
  {
    provider: 'Кнежа газ',
    city: 'Кнежа',
    url: 'https://knezha-gaz.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'gas'
  },
  {
    // Found via a systematic sweep for "phantom" providers — url-health
    // already tracked this URL as "healthy" without any actual
    // PROVIDER_TARGETS entry ever existing for it, the exact same gap that
    // hid the Топлофикация Перник/Русе outages: a provider can look
    // monitored in the admin panel's link-health list while never actually
    // being scraped for content at all.
    provider: 'Костинбродгаз',
    city: 'Костинброд',
    url: 'https://kostinbrodgaz.bg/новини/',
    selector: '.news-item, article, p',
    defaultUtility: 'gas'
  },
  {
    provider: 'Правецгаз 1',
    city: 'Правец',
    url: 'https://www.pravecgas1.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'gas'
  },
  {
    provider: 'Газинженеринг',
    city: 'София',
    url: 'https://gasengeneering.bg/',
    selector: '.news-item, article, p',
    defaultUtility: 'gas'
  },
  {
    provider: 'Каварна газ',
    city: 'Каварна',
    url: 'http://kavarnagas.my.contact.bg/',
    selector: '.news-item, article, p',
    defaultUtility: 'gas'
  },
  {
    provider: 'Газо-Енергийно Дружество Елин Пелин',
    city: 'Елин Пелин',
    url: 'https://gas-elinpelin.eu/',
    selector: '.news-item, article, p',
    defaultUtility: 'gas'
  },
  // Cross-checked against KEVR's official 22-company gas distribution
  // register — these 4 were confirmed reachable; ЗИВ (Балчик), Неврокоп-газ
  // (Гоце Делчев), Карловогаз, ЕМИ and ТЕЦЕКО (site's HTTPS is broken —
  // confirmed, not just a transient miss) had no working site to scrape,
  // and Райков сервиз turned out to be a gas-station equipment manufacturer,
  // not a municipal distribution network.
  {
    provider: 'Камено-газ',
    city: 'Камено',
    url: 'http://kameno-gaz.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'gas'
  },
  {
    provider: 'Комекес',
    city: 'Самоков',
    url: 'https://www.komekes.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'gas'
  },
  {
    provider: 'Газтрейд Сливен',
    city: 'Сливен',
    url: 'https://gastrade-sliven.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'gas'
  },
  {
    provider: 'Свиленград-газ',
    city: 'Свиленград',
    url: 'http://www.svilengradgaz.com/',
    selector: '.news-item, article, p',
    defaultUtility: 'gas'
  },
];

/**
 * High-fidelity Bulgarian Outage Announcements for All Regions
 */
export const SAMPLE_BULGARIAN_ANNOUNCEMENTS = [
  // София
  {
    provider: 'Софийска вода',
    city: 'София',
    text: 'Поради авариен ремонт на уличен водопровод по ул. Иван Вазов и ул. Шипка от 10:00 до 16:30 ч. се спира водоподаването на абонатите в района.'
  },
  {
    provider: 'Електрохолд',
    city: 'София',
    text: 'Планова подмяна на съоръжения 10kV в района на бул. България №45 и ул. Гоце Делчев от 09:00 ч. до 17:00 ч.'
  },
  {
    provider: 'Топлофикация София',
    city: 'София',
    text: 'Във връзка с отстраняване на пробив на магистрален топлопровод се спира топлоподаването в кв. Младост 1 и ул. Ерусалим от 08:30 до 18:00 ч.'
  },
  {
    provider: 'Овергаз Мрежи',
    city: 'София',
    text: 'Планово присъединяване и профилактика на разпределителен газопровод по ул. Оборище и ул. Сан Стефано в гр. София от 09:00 до 16:00 ч. Временно се спира газоподаването.'
  },
  // Пловдив
  {
    provider: 'EVN България',
    city: 'Пловдив',
    text: 'Поради планирана профилактика на трафопост в гр. Пловдив, бул. Цар Борис III Обединител и ул. Капитан Райчо от 11:00 ч. до 15:00 ч. ще има смущения в електроснабдяването.'
  },
  {
    provider: 'ВиК Пловдив',
    city: 'Пловдив',
    text: 'Авария на уличен водопровод по бул. 6-ти Септември и бул. Руски в гр. Пловдив от 09:30 до 16:00 ч.'
  },
  {
    provider: 'EVN Топлофикация',
    city: 'Пловдив',
    text: 'Аварийно спиране на топлоподаването в район Тракия, бул. Освобождение от 10:00 до 17:00 ч.'
  },
  // Варна
  {
    provider: 'Енерго-Про (ЕРП Север)',
    city: 'Варна',
    text: 'Във връзка с неотложни ремонтни дейности по електроразпределителната мрежа в гр. Варна по бул. Владислав Варненчик и бул. Княз Борис I токът ще бъде спрян от 08:30 до 16:30 ч.'
  },
  {
    provider: 'ВиК Варна',
    city: 'Варна',
    text: 'Авария на главен водопроводен клон по бул. Сливница и ул. Отец Паисий в гр. Варна от 09:00 до 17:00 ч.'
  },
  {
    provider: 'Веолия Енерджи Варна',
    city: 'Варна',
    text: 'Планов ремонт на абонатни станции в ж.к. Младост, гр. Варна от 09:00 до 15:00 ч.'
  },
  {
    provider: 'Овергаз Мрежи',
    city: 'Варна',
    text: 'Авариен ремонт на газорегулираща станция в гр. Варна, ж.к. Чайка и бул. Васил Левски от 10:00 до 16:30 ч. с прекъсване на природния газ.'
  },
  // Бургас
  {
    provider: 'EVN България',
    city: 'Бургас',
    text: 'Планирано прекъсване на електрозахранването в гр. Бургас по ул. Александровска и ул. Богориди от 09:00 до 13:00 ч.'
  },
  {
    provider: 'ВиК Бургас',
    city: 'Бургас',
    text: 'Авариен ремонт на водопровод по бул. Стефан Стамболов и бул. Демокрация в гр. Бургас от 10:00 до 16:00 ч.'
  },
  {
    provider: 'Топлофикация Бургас',
    city: 'Бургас',
    text: 'Спиране на горещата вода в к-с Лазур, гр. Бургас от 08:00 до 17:00 ч.'
  },
  // Русе
  {
    provider: 'Енерго-Про (ЕРП Север)',
    city: 'Русе',
    text: 'Временни смущения в електроподаването по бул. Христо Ботев и бул. Липник в гр. Русе от 10:00 до 14:00 ч.'
  },
  {
    provider: 'ВиК Русе',
    city: 'Русе',
    text: 'Авария на водопроводна мрежа по ул. Александровска и бул. Цар Освободител в гр. Русе от 09:00 до 14:30 ч.'
  },
  {
    provider: 'Овергаз Мрежи',
    city: 'Русе',
    text: 'Профилактика и изпитване на газопреносен клон по бул. Скобелев и ул. Борисова в гр. Русе от 09:30 до 15:30 ч. Временно се спира газоподаването.'
  },
  // Стара Загора
  {
    provider: 'EVN България',
    city: 'Стара Загора',
    text: 'Профилактика на електроразпределителната мрежа в гр. Стара Загора по бул. Митрополит Методий Кусев от 09:00 до 15:00 ч.'
  },
  {
    provider: 'ВиК Стара Загора',
    city: 'Стара Загора',
    text: 'Ремонтни дейности по водопроводната мрежа по бул. Цар Симеон Велики и ул. Генерал Гурко в гр. Стара Загора от 10:00 до 16:00 ч.'
  },
  {
    provider: 'Овергаз Мрежи',
    city: 'Стара Загора',
    text: 'Планов ремонт на газопроводно отклонение по ул. Генерал Столетов и бул. Руски в гр. Стара Загора от 09:00 до 16:00 ч.'
  },
  // Велико Търново
  {
    provider: 'Енерго-Про (ЕРП Север)',
    city: 'Велико Търново',
    text: 'Планови ремонти на електропроводи по ул. Независимост и ул. Стефан Стамболов в гр. Велико Търново от 08:30 до 16:00 ч.'
  },
  {
    provider: 'ВиК Йовковци',
    city: 'Велико Търново',
    text: 'Авариен ремонт на водопроводната мрежа за ул. Шемшевско шосе и ул. Симеон Велики № 1 в гр. Велико Търново от 09:00 до 14:00 ч.'
  },
  {
    provider: 'Овергаз Мрежи',
    city: 'Велико Търново',
    text: 'Профилактика на разпределителна газова мрежа по ул. Васил Левски и ул. Независимост в гр. Велико Търново от 09:00 до 15:00 ч.'
  },
  // Плевен
  {
    provider: 'Електрохолд',
    city: 'Плевен',
    text: 'Планово изключване на захранването по ул. Васил Левски и ул. Дойран в гр. Плевен от 09:00 до 16:00 ч.'
  },
  {
    provider: 'ВиК Плевен',
    city: 'Плевен',
    text: 'Аварийно спиране на водоподаването по бул. Данаил Попов и ул. Сан Стефано в гр. Плевен от 10:00 до 15:30 ч.'
  },
  {
    provider: 'Аресгаз',
    city: 'Плевен',
    text: 'Планово спиране на газоподаването поради присъединяване на нови абонати по ж.к. Сторгозия и ул. Дойран в гр. Плевен от 09:00 до 16:00 ч.'
  },
  // Благоевград
  {
    provider: 'Електрохолд',
    city: 'Благоевград',
    text: 'Ремонт на трафопост по бул. Св. Кирил и Методий и ул. Тодор Александров в гр. Благоевград от 08:30 до 14:00 ч.'
  },
  {
    provider: 'ВиК Благоевград',
    city: 'Благоевград',
    text: 'Авария на уличен водопровод по ул. Иван Михайлов и ул. Владо Черноземски в гр. Благоевград от 09:00 до 16:00 ч.'
  },
  // Сливен
  {
    provider: 'EVN България',
    city: 'Сливен',
    text: 'Планова профилактика по бул. Цар Освободител и бул. Хаджи Димитър в гр. Сливен от 09:00 до 15:00 ч.'
  },
  {
    provider: 'ВиК Сливен',
    city: 'Сливен',
    text: 'Авария на главен клон по бул. Стефан Караджа и ул. Раковски в гр. Сливен от 10:00 до 16:30 ч.'
  },
  // Добрич
  {
    provider: 'Енерго-Про (ЕРП Север)',
    city: 'Добрич',
    text: 'Планови ремонтни дейности по бул. 25-ти Септември и бул. Добруджа в гр. Добрич от 08:30 до 15:30 ч.'
  },
  {
    provider: 'ВиК Добрич',
    city: 'Добрич',
    text: 'Спиране на водата поради авария по ул. Отец Паисий и ул. Независимост в гр. Добрич от 09:00 до 16:00 ч.'
  },
  // Шумен
  {
    provider: 'Енерго-Про (ЕРП Север)',
    city: 'Шумен',
    text: 'Профилактика на мрежата по бул. Славянски и бул. Симеон Велики в гр. Шумен от 09:00 до 14:00 ч.'
  },
  {
    provider: 'ВиК Шумен',
    city: 'Шумен',
    text: 'Авариен ремонт на довеждащ водопровод по ул. Съединение и ул. Цар Освободител в гр. Шумен от 10:00 до 17:00 ч.'
  },
  // Перник
  {
    provider: 'Електрохолд',
    city: 'Перник',
    text: 'Планови прекъсвания на тока по ул. Търговска и ул. Кракра в гр. Перник от 09:00 до 16:00 ч.'
  },
  {
    provider: 'ВиК Перник',
    city: 'Перник',
    text: 'Авария на водопроводна мрежа в кв. Изток и ул. Юрий Гагарин в гр. Перник от 09:30 до 15:00 ч.'
  },
  // Хасково
  {
    provider: 'EVN България',
    city: 'Хасково',
    text: 'Профилактика на съоръжения 20kV по бул. България и бул. Освобождение в гр. Хасково от 09:00 до 14:30 ч.'
  },
  {
    provider: 'ВиК Хасково',
    city: 'Хасково',
    text: 'Авария на водопровод по ул. Сан Стефано и ул. Дунав в гр. Хасково от 10:00 до 16:00 ч.'
  },
  // Пазарджик
  {
    provider: 'EVN България',
    city: 'Пазарджик',
    text: 'Планови дейности по електрозахранването по бул. България и ул. Пловдивска в гр. Пазарджик от 08:30 до 15:00 ч.'
  },
  {
    provider: 'ВиК Пазарджик',
    city: 'Пазарджик',
    text: 'Аварийно спиране на водата по ул. Генерал Гурко и ул. Хан Крум в гр. Пазарджик от 09:30 до 16:00 ч.'
  },
  // Габрово
  {
    provider: 'Енерго-Про (ЕРП Север)',
    city: 'Габрово',
    text: 'Временни прекъсвания на тока по ул. Радецка и бул. Априлов в гр. Габрово от 09:00 до 14:00 ч.'
  },
  {
    provider: 'ВиК Габрово',
    city: 'Габрово',
    text: 'Авария на уличен водопровод по ул. Брянска и ул. Скобелевска в гр. Габрово от 10:00 до 15:30 ч.'
  },
  {
    provider: 'Ситигаз България',
    city: 'Габрово',
    text: 'Профилактика на газорегулиращ пункт по ул. Радецка и бул. Априлов в гр. Габрово от 09:00 до 14:30 ч. с временно прекъсване на природния газ.'
  },
  // Враца
  {
    provider: 'Електрохолд',
    city: 'Враца',
    text: 'Планови прекъсвания по бул. Христо Ботев и ул. Никола Войводов в гр. Враца от 08:30 до 16:00 ч.'
  },
  {
    provider: 'ВиК Враца',
    city: 'Враца',
    text: 'Авария на водопровод по бул. Васил Кънчов и ул. Полковник Кетхудов в гр. Враца от 09:00 до 15:00 ч.'
  }
];

/**
 * Dedicated Real-Time Scraper for Софийска вода's official ArcGIS
 * InfoCenter feed. This used to query ONLY MapServer layer 2 ("Текущи
 * спирания" / current-emergency stoppages) — confirmed live, that layer's
 * sibling layer 3 ("Планирани спирания" / PLANNED stoppages) is a
 * completely separate layer this never touched, and it currently holds 5
 * real active planned works layer 2 has none of. This is exactly why Sofia
 * water outages looked near-empty despite real ones existing on the
 * provider's own site.
 *
 * Also switched from returning free-text items for the generic
 * PROVIDER_TARGETS pipeline to calling upsertOutage() directly with the
 * feed's own START_/ALERTEND epoch-millisecond fields — the old text (built
 * from START_H/START_M only, no calendar date) silently defaulted every
 * entry to "today" once re-parsed generically, which is wrong for a
 * planned closure dated days or weeks out. OBJECTID (ArcGIS's own stable
 * primary key) confirmed identical across two live fetches 3 seconds apart,
 * so it's safe as an exact-match key.
 */
/**
 * Софийска вода's LOCATION field is a whole sentence ("зона за спиране- с. Владая- района
 * заключен между ЖП линия „София-Перник“, ул. „Лесковец“, ул. „Войнишко въстание“ и в.з.
 * Приплат"). Stored as ONE "street" it could be neither shown as a list nor matched against a
 * resident's street; split into its real entries (the pin itself is the polygon centre, see
 * ZONE_CENTRE_PROVIDERS). A zone with nothing recognisable keeps its cleaned wording.
 */
export function sofiaZoneEntries(loc) {
  const cleaned = String(loc || '')
    .replace(/^\s*зона\s+(?:на|за)\s+спиране\s*[-–:]*\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const found = extractStreetsHeuristic(cleaned).filter((e) => !/^централна градска част$/i.test(e));
  return found.length > 0 ? found : [cleaned.slice(0, 160) || String(loc || '').trim()];
}

export async function scrapeSofiaWaterGis(dryRun = false, dryRunCandidates = null) {
  console.log('💧 [СОФИЙСКА ВОДА] Fetching live + planned water stoppages for Sofia...');
  const layers = [
    { id: 2, kind: 'Текущо (аварийно) спиране' },
    { id: 3, kind: 'Планирано спиране' }
  ];

  let totalFound = 0;
  let totalParsed = 0;
  let totalSaved = 0;
  // Both layers fetched and processed without an error: only then is "no longer in the feed" trustworthy.
  const passStartedAt = Date.now();
  let layersOk = 0;

  for (const layer of layers) {
    try {
      // outSR=4326 asks ArcGIS to reproject server-side to plain WGS84
      // lat/lng — confirmed live the layer's NATIVE spatial reference is
      // wkid 103535 (a local Bulgarian projected CRS, coordinates in
      // meters), so using geometry.rings x/y raw would have been wildly
      // wrong without this. geometryType is esriGeometryPolygon — this IS
      // the real affected-zone shape the provider's own map draws, not
      // reconstructed from text.
      const url = `https://gispx.sofiyskavoda.bg/arcgis/rest/services/WSI_PUBLIC/InfoCenter_Public/MapServer/${layer.id}/query?where=1%3D1&outFields=*&outSR=4326&f=json`;
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://gispx.sofiyskavoda.bg/WebApp.InfoCenter/?a=0&tab=0',
          'Origin': 'https://gispx.sofiyskavoda.bg'
        },
        timeout: 7000
      });

      const features = Array.isArray(res.data?.features) ? res.data.features : [];
      totalFound += features.length;

      for (const f of features) {
        const attr = f.attributes || {};
        const loc = (attr.LOCATION || '').trim();
        if (loc.length < 5) continue;
        totalParsed++;

        const alertType = attr.ALERTTYPE || layer.kind;
        const now = new Date();

        // START_ and ALERTEND are confirmed live to ALWAYS be identical,
        // for every single feature on both layers — this pair is a bare
        // reference timestamp (not aligned to midnight, not meaningfully
        // a "start" or "end"), and the REAL time-of-day window lives
        // entirely in the separate START_H/START_M/END_H/END_M fields.
        // Treating START_/ALERTEND as the actual start/end made every
        // entry a zero-duration event landing wherever that reference
        // timestamp happened to fall — one real record was already a day
        // in the past by the time this ran, so it computed as
        // instantly-resolved on every scrape and silently re-inserted as
        // a fresh duplicate row each cycle (the same failure mode as the
        // multi-day date-range bug elsewhere in this codebase). Extracts
        // just the Sofia-LOCAL calendar date from the reference
        // timestamp, then rebuilds real start/end from that date plus the
        // separate H:M fields, using the same DST-aware offset as every
        // other date parser here.
        const refMs = typeof attr.START_ === 'number' ? attr.START_ : Date.now();
        const refUtcDate = new Date(refMs);
        const provisionalOffset = getBulgariaUtcOffsetHours(refUtcDate.getUTCFullYear(), refUtcDate.getUTCMonth(), refUtcDate.getUTCDate());
        const localRef = new Date(refMs + provisionalOffset * 3600000);
        const y = localRef.getUTCFullYear();
        const mo = localRef.getUTCMonth();
        const d = localRef.getUTCDate();

        const startH = parseInt(attr.START_H, 10) || 0;
        const startM = parseInt(attr.START_M, 10) || 0;
        const endH = parseInt(attr.END_H, 10);
        const endM = parseInt(attr.END_M, 10) || 0;
        const hasRealEndHour = !Number.isNaN(endH);
        const offset = getBulgariaUtcOffsetHours(y, mo, d);

        const startTime = new Date(Date.UTC(y, mo, d, startH - offset, startM, 0));
        let endTime = new Date(Date.UTC(y, mo, d, (hasRealEndHour ? endH : startH + 4) - offset, endM, 0));
        if (endTime.getTime() <= startTime.getTime()) endTime = new Date(endTime.getTime() + 24 * 3600000);

        let status = 'active';
        if (endTime.getTime() <= now.getTime()) status = 'resolved';
        else if (startTime.getTime() > now.getTime()) status = 'scheduled';

        // upsertOutage()'s own duplicate-search only looks at
        // active/scheduled rows (see its own comment for why) — a source
        // entry that's already resolved by the time it's first seen here
        // has no existing row to match against, so it would insert a
        // brand-new row every single scrape cycle forever instead of ever
        // converging. Confirmed live: the provider's own feed keeps
        // serving a stale already-past entry indefinitely, and skipping
        // it here (rather than inserting a one-time-useless resolved row)
        // is exactly what stopped it from accumulating.
        if (status === 'resolved') continue;

        // ArcGIS gives real, structured start/end times (START_H/M, END_H/M
        // above) — never a text-parsed guess — but the display layer's
        // time_is_estimated flag (hasExplicitTimeInText, aiParserService.js)
        // only ever checks raw_location_text for a literal "HH:MM"-shaped
        // pattern, since that's the only signal it has for every OTHER
        // provider (whose times DO come from free text). Without embedding
        // the real time here, a genuinely precise structured end time was
        // shown as if it were unknown ("До отстраняване на аварията"),
        // hiding real information — confirmed live. Embeds the SAME literal
        // "от X до Y ч." shape parseBulgarianDateTime()/hasExplicitTimeInText
        // already recognize, so this reuses that existing, tested logic
        // instead of adding a second parallel "is this real" signal.
        // Mirrors the source honestly when END_H is genuinely absent — "до
        // отстраняване", not a fabricated end clock time.
        const pad2 = (n) => String(n).padStart(2, '0');
        const timeText = hasRealEndHour
          ? ` от ${pad2(startH)}:${pad2(startM)} ч. до ${pad2(endH)}:${pad2(endM)} ч.`
          : ` от ${pad2(startH)}:${pad2(startM)} ч. до отстраняване.`;
        const raw_location_text = cleanOutageAnnouncementText(`Софийска вода уведомява: ${alertType} - ${loc}.${timeText}`);

        // Real coordinate from the provider's own polygon (the actual
        // affected zone their map draws), not the generic city-center
        // fallback — a simple average of the ring's own vertices, which
        // for an ordinary (non-self-intersecting, roughly convex-ish)
        // neighborhood zone lands solidly inside the real shape. Only
        // used when it's genuinely present and sane (Sofia's own lat/lng
        // range) — anything else falls through to upsertOutage()'s normal
        // text-based geocoding fallback, same as before this existed.
        const zoneCenter = computePolygonRingCentroid(f.geometry);

        await upsertOrCollect({
          utility_type: 'water',
          provider: 'Софийска вода',
          city: 'София',
          raw_location_text,
          affected_streets: sofiaZoneEntries(loc),
          lat: zoneCenter?.lat,
          lng: zoneCenter?.lng,
          source_url: 'https://gispx.sofiyskavoda.bg/WebApp.InfoCenter/?a=0&tab=0',
          start_time: startTime.toISOString(),
          expected_end_time: endTime.toISOString(),
          status,
          source_announcement_key: attr.OBJECTID ? `sofiyskavoda:${attr.OBJECTID}` : null
        }, dryRun, dryRunCandidates);
        totalSaved++;
      }
      layersOk++;
    } catch (err) {
      console.warn(`Sofia Water GIS error (layer ${layer.id}):`, err.message);
    }
  }

  // A zone that left the provider's map (work finished early) used to stay until its planned end.
  if (!dryRun && layersOk === layers.length) {
    await closeVanishedOutages({ provider: 'Софийска вода', keyPrefixes: ['sofiyskavoda:'], passStartedAt })
      .catch((e) => console.warn('Sofia Water sync error:', e.message));
  }

  await logAndRecordScraperStats('Софийска вода', { found: totalFound, parsed: totalParsed, saved: totalSaved });
  return totalSaved;
}

/**
 * Dedicated Real-Time Scraper for Топлофикация София (district heating) via
 * toplo.bg's own embedded structured JSON feed. The public page at
 * /accidents-and-maintenance renders every "Авария" (Type 0) and "Ремонт"
 * (Type 1) entry — both tabs — as raw JS object literals inside a <script>
 * tag in the SAME static HTML response (no AJAX/JS execution needed), with
 * exact ISO 8601 UTC FromDate/UntilDate fields. Using those directly instead
 * of scraping/parsing free Bulgarian text avoids month-name ambiguity
 * entirely and is far more reliable than the generic PROVIDER_TARGETS loop —
 * confirmed live: 41/41 entries parse cleanly with this regex.
 */
export async function scrapeSofiaHeatingToplo(dryRun = false, dryRunCandidates = null) {
  console.log('🔥 [TOPLO.BG] Fetching live heating accidents/maintenance for Sofia...');
  let totalParsed = 0;
  try {
    const res = await axios.get('https://toplo.bg/accidents-and-maintenance', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 8000
    });

    const html = typeof res.data === 'string' ? res.data : String(res.data);
    const entryRe = /\{\r\n\s*"AccidentId":[\s\S]*?"ContentItemId":\s*"[^"]*"\r?\n?\s*\}/g;
    const matches = html.match(entryRe) || [];

    for (const raw of matches) {
      try {
        const item = JSON.parse(raw);
        const district = (item.Region || item.Name || 'София').trim();
        const addressesRaw = (item.Addresses || '').replace(/[\r\n]+/g, ' ').trim();

        // "целият квартал"/"целия квартал" means the whole district is
        // affected with no specific street list — match on the
        // neighborhood name itself, since that's how Sofia users typically
        // save their address (e.g. "жк Младост 3").
        const isWholeDistrict = !addressesRaw || /цели[ият]{1,3}\s+квартал/i.test(addressesRaw);
        // toplo.bg's own Addresses field states a prefix ONCE per group and
        // then lists further numbers by comma alone ("бл. 40, 44, 138, 139"
        // — one shared "бл." for all four), using semicolon only to
        // separate GENUINELY different groups ("бл.№ 1, 2, 3; ул. "Петър
        // Протич" бл.31" — two distinct groups). Splitting on comma (the
        // old behavior) tore each shared-prefix list apart into a bare,
        // meaningless "44", "138"... one per number, alongside actual
        // street/venue names caught in the same split ("М-н "Панда"",
        // "Зала "Бокс"") — confirmed live, one single record had
        // accumulated 33 such fragments. Splitting on semicolon instead
        // keeps each shared-prefix group intact as one string.
        const affected_streets = isWholeDistrict
          ? [district]
          : addressesRaw.split(';').map((s) => s.trim()).filter(Boolean);
        if (!affected_streets.includes(district)) affected_streets.push(district);

        const now = new Date();
        const hasRealFromDate = !!item.FromDate;
        const hasRealUntilDate = !!item.UntilDate;
        const startTime = hasRealFromDate ? new Date(item.FromDate) : now;
        const endTime = hasRealUntilDate ? new Date(item.UntilDate) : new Date(now.getTime() + 24 * 3600 * 1000);

        // Same status-lifecycle convention as parseBulgarianDateTime().
        let status = 'active';
        if (endTime.getTime() <= now.getTime()) status = 'resolved';
        else if (startTime.getTime() > now.getTime()) status = 'scheduled';

        const kindLabel = item.Type === 1 ? 'Планов ремонт по топлопреносната мрежа' : 'Авария по топлопреносната мрежа';
        // toplo.bg gives real, structured FromDate/UntilDate — never a
        // guess — but the display layer's time_is_estimated flag
        // (hasExplicitTimeInText, aiParserService.js) only ever recognizes a
        // literal "HH:MM"-shaped pattern in raw_location_text, since that's
        // the only signal it has for every OTHER provider (whose times come
        // from free text). See scrapeSofiaWaterGis() for the same fix and
        // full reasoning — without this, a genuinely precise structured end
        // time was shown as "До отстраняване на аварията" as if unknown.
        const bgTimeFmt = new Intl.DateTimeFormat('bg-BG', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit' });
        const timeText = hasRealFromDate
          ? (hasRealUntilDate
            ? ` от ${bgTimeFmt.format(startTime)} ч. до ${bgTimeFmt.format(endTime)} ч.`
            : ` от ${bgTimeFmt.format(startTime)} ч. до отстраняване.`)
          : '';
        const raw_location_text = (isWholeDistrict
          ? `${kindLabel}: спряно е топлоподаването в кв. ${district} (целият квартал).`
          : `${kindLabel}: спряно е топлоподаването на ${addressesRaw} в кв. ${district}.`) + timeText;

        await upsertOrCollect({
          utility_type: 'heating',
          provider: 'Топлофикация София',
          city: 'София',
          region: district,
          raw_location_text,
          affected_streets,
          source_url: 'https://toplo.bg/accidents-and-maintenance',
          start_time: startTime.toISOString(),
          expected_end_time: endTime.toISOString(),
          status
          // REVERTED: tried using toplo.bg's AccidentId as a
          // source_announcement_key (like ЕРП Север/EVN), assuming it was a
          // stable per-incident id. Confirmed live it is NOT — fetched the
          // same feed twice 3 seconds apart and all 61 real incidents (same
          // Addresses+Region text each time) came back with a completely
          // DIFFERENT AccidentId on the second fetch, zero overlap. Using
          // it as an exact-match key meant every single scrape (every cron
          // tick, every manual run) created 61 brand new rows instead of
          // updating the existing ones — ~1500 rows accumulated in the
          // hours this was live before being caught. Falls back to
          // sameOutageMatch()'s bare-block-number heuristic instead, same
          // as before this was ever added.
        }, dryRun, dryRunCandidates);
        totalParsed++;
      } catch (e) {
        console.warn('Toplo.bg entry parse error:', e.message);
      }
    }
  } catch (err) {
    console.warn('Toplo.bg (Sofia Heating) scraping error:', err.message);
  }

  console.log(`✅ [TOPLO.BG] Processed ${totalParsed} heating accidents/maintenance entries for Sofia.`);
  await recordScraperRun('Топлофикация София', { found: totalParsed, parsed: totalParsed, saved: totalParsed });
  return totalParsed;
}

// "DD.MM.YYYY HH:MM" in Bulgarian local time (info.ermzapad.bg's own
// begin_event/end_event format) -> a real UTC Date, using the same
// DST-aware offset as every other parser in this codebase so a
// winter-time outage doesn't silently land an hour off.
function parseElektroholdEventDate(str) {
  const m = (str || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, d, mo, y, h, mi] = m.map(Number);
  const offset = getBulgariaUtcOffsetHours(y, mo - 1, d);
  return new Date(Date.UTC(y, mo - 1, d, h - offset, mi, 0));
}

/**
 * Dedicated Real-Time Scraper for Електрохолд (ЕРМ Запад — all 10 Western
 * Bulgarian provinces incl. Sofia-grad/SOF and Sofia-oblast/SFO) via
 * info.ermzapad.bg's own interactive outage-map endpoint.
 *
 * The old PROVIDER_TARGETS entry pointed at ermzapad.bg's static landing
 * page (a marketing page with two outbound buttons, no outage data of its
 * own) using a generic selector that only ever matched nav/footer text —
 * confirmed live, it returned zero real outage content for ANY of the 10
 * provinces, not just Sofia: fetching that page directly, the raw HTML
 * doesn't contain the word "София" — or any settlement name — anywhere at
 * all. The REAL data lives on a completely different subdomain
 * (info.ermzapad.bg), reached only via a button labeled "Проверете тук".
 *
 * That real tool renders a card, server-side, for each province that
 * currently has at least one qualifying event (confirmed live: on a
 * typical check only 2-3 of the 10 province cards are present at all —
 * this is expected, not a bug, when the other provinces genuinely have
 * nothing active). Walking the `show_obstina('MUNI_CODE','REGION_CODE')`
 * calls server-rendered into that page, instead of hardcoding a
 * municipality list, means newly affected municipalities in ANY of the 10
 * provinces (including Sofia) are picked up automatically as soon as the
 * tool itself starts showing them — no maintenance needed here if
 * Electrohold adds/renames a municipality on their end.
 */
export async function scrapeElektroholdLivePower(dryRun = false, dryRunCandidates = null) {
  console.log('⚡ [ЕЛЕКТРОХОЛД] Fetching live power outages across ЕРМ Запад (10 provinces incl. Sofia)...');
  const baseUrl = 'https://info.ermzapad.bg/webint/vok/avplan.php';
  const regionNames = {
    SOF: 'София', SFO: 'София-област', PER: 'Перник', KNL: 'Кюстендил',
    BLG: 'Благоевград', PVN: 'Плевен', LOV: 'Ловеч', VRC: 'Враца',
    MON: 'Монтана', VID: 'Видин'
  };

  let totalMunicipalities = 0;
  let totalParsed = 0;
  let totalSaved = 0;
  // Every municipality the page lists was fetched and processed without an error:
  // only then can "no longer listed" be trusted for the whole provider.
  const passStartedAt = Date.now();
  let pageFetched = false;
  let anyMunicipalityFailed = false;
  const completeMunicipalityPrefixes = [];

  try {
    const pageRes = await axios.get(baseUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 10000
    });
    const html = typeof pageRes.data === 'string' ? pageRes.data : String(pageRes.data);
    pageFetched = pageRes.status === 200 && html.length > 500;

    const muniMatches = [...html.matchAll(/show_obstina\('([A-Z]+\d+)','([A-Z]+)'\)/g)];
    const uniqueMunis = [...new Map(muniMatches.map((m) => [m[1], m[2]])).entries()];
    totalMunicipalities = uniqueMunis.length;

    for (const [muniCode, regionCode] of uniqueMunis) {
      try {
        const body = `action=draw&gm_obstina=${muniCode}&lat=42.6977&lon=23.3219`;
        const res = await axios.post(baseUrl, body, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': baseUrl
          },
          timeout: 10000
        });

        const obj = res.data;
        if (!obj || typeof obj !== 'object') { anyMunicipalityFailed = true; continue; }
        const entries = Object.values(obj).filter((e) => e && e.begin_event && e.city_name);
        if (entries.length === 0) { completeMunicipalityPrefixes.push(`elektrohold:${muniCode}:`); continue; }

        // A single municipality-wide response comes back as one row PER
        // DISTRIBUTION-GRID SEGMENT (Electrohold's own internal `ceo`
        // id), not one row per real event — confirmed live, a single
        // Radomir maintenance window came back as 9 separate grid-segment
        // rows all sharing the exact same begin_event/end_event/typedist,
        // covering just 4 distinct real settlements between them. Groups
        // by the real event window instead, unioning every segment's
        // settlement name into one record's affected_streets — the same
        // "one bulletin, many villages" shape every other provider here
        // already uses.
        const groups = new Map();
        for (const e of entries) {
          const key = `${e.typedist}|${e.begin_event}|${e.end_event}`;
          if (!groups.has(key)) groups.set(key, { ...e, cityNames: new Set() });
          const cleanCity = (e.city_name || '').split(',')[0].trim();
          if (cleanCity) groups.get(key).cityNames.add(cleanCity);
        }

        const regionName = regionNames[regionCode] || regionCode;
        const cityForRecord = regionCode === 'SOF' ? 'София' : regionName;

        for (const group of groups.values()) {
          totalParsed++;
          // The API gives bare, upper-case settlement names ("ПИСАРОВО", "ГОРНИ
          // ДЪБНИК") — shown as "ул. ПИСАРОВО" in the popup. Give each its real
          // type and canonical spelling from the settlement registry ("с. Писарово")
          // when it is found in the province. The announcement key below is still
          // built from the ORIGINAL names, so existing rows keep matching (their
          // labels are then repaired in place by the street merge).
          const originalNames = [...group.cityNames];
          const affected_streets = originalNames.map((name) => {
            const regionForLookup = (regionCode === 'SOF' || regionCode === 'SFO') ? 'София-град' : regionName;
            const found = getSettlementCoordinates(name, '', regionForLookup);
            return found && !found.isRegionFallback && found.name ? `${found.type === 'гр.' ? 'гр.' : 'с.'} ${found.name}` : name;
          });
          if (affected_streets.length === 0) continue;

          const startTime = parseElektroholdEventDate(group.begin_event);
          const endTime = parseElektroholdEventDate(group.end_event);
          if (!startTime || !endTime) continue;

          const now = new Date();
          let status = 'active';
          if (endTime.getTime() <= now.getTime()) status = 'resolved';
          else if (startTime.getTime() > now.getTime()) status = 'scheduled';

          // See scrapeSofiaWaterGis() for why: upsertOutage()'s own
          // duplicate-search only looks at active/scheduled rows, so a
          // group that's already resolved by the time it's first seen
          // here has nothing to match against and would insert a fresh
          // row every scrape cycle forever instead of converging.
          if (status === 'resolved') continue;

          const kindLabel = group.typedist === 'планирано' ? 'Планов ремонт по електроразпределителната мрежа' : 'Непланирано прекъсване на електрозахранването';
          const raw_location_text = `${kindLabel} засяга: ${affected_streets.join(', ')} (общ. ${regionName}), от ${group.begin_event} до ${group.end_event}.`;

          await upsertOrCollect({
            utility_type: 'electricity',
            provider: 'Електрохолд',
            // A notice about villages belongs under its first (registry-confirmed)
            // village, like ЕРП Север's — not under the province name, which the popup
            // then showed as "гр. Плевен" over a village in Плевен province. Sofia city
            // and notices without a confirmed settlement keep the province/city.
            city: (() => {
              if (regionCode === 'SOF') return cityForRecord;
              const firstTyped = affected_streets.find((s) => /^(?:с\.|гр\.)\s+/.test(s));
              return firstTyped ? firstTyped.replace(/^(?:с\.|гр\.)\s+/, '').trim() : cityForRecord;
            })(),
            region: regionName,
            raw_location_text,
            affected_streets,
            source_url: baseUrl,
            lat: parseFloat(group.lat) || undefined,
            lng: parseFloat(group.lon) || undefined,
            start_time: startTime.toISOString(),
            expected_end_time: endTime.toISOString(),
            status,
            source_announcement_key: `elektrohold:${muniCode}:${group.begin_event}:${group.end_event}:${originalNames.slice().sort().join(',')}`
          }, dryRun, dryRunCandidates);
          totalSaved++;
        }
        completeMunicipalityPrefixes.push(`elektrohold:${muniCode}:`);
      } catch (e) {
        anyMunicipalityFailed = true;
        console.warn(`Електрохолд draw() error for ${muniCode}:`, e.message);
      }
    }
  } catch (err) {
    console.warn('Електрохолд scraping error:', err.message);
  }

  // A municipality that dropped out of the page's list altogether has no events
  // left, so the whole-provider prefix is used when everything listed went through
  // cleanly; otherwise only the municipalities that did.
  if (!dryRun && pageFetched) {
    await closeVanishedOutages({
      provider: 'Електрохолд',
      keyPrefixes: anyMunicipalityFailed ? completeMunicipalityPrefixes : ['elektrohold:'],
      passStartedAt
    }).catch((e) => console.warn('Електрохолд sync error:', e.message));
  }

  await logAndRecordScraperStats('Електрохолд', { found: totalMunicipalities, parsed: totalParsed, saved: totalSaved, label: 'Засегнати общини' });
  return totalSaved;
}

/**
 * Dedicated Real-Time Scraper for ВиК Стара Загора's own outage log,
 * covering all 4 of its districts (Стара Загора, Казанлък, Чирпан,
 * Раднево). The old PROVIDER_TARGETS entry pointed at the bare corporate
 * homepage (wik-stz.com, no outage listing at all) — the real, richly
 * detailed, currently-updated log lives on a completely separate subdomain
 * (avarii.wik-stz.com), reached only via a "аварии и ремонти по райони"
 * link. Each district page is a single reverse-chronological HTML table
 * going back to 2015 — only walks it until a date more than MAX_AGE_DAYS
 * in the past is hit, since everything after that in a reverse-sorted
 * table is even older.
 */
export async function scrapeStaraZagoraWaterLive(dryRun = false, dryRunCandidates = null) {
  console.log('💧 [ВиК СТАРА ЗАГОРА] Fetching live water outages across 4 districts...');
  const districts = [
    { name: 'Стара Загора', url: 'http://avarii.wik-stz.com/2015/08/06/%D1%80%D0%B0%D0%B9%D0%BE%D0%BD-%D1%81%D1%82%D0%B0%D1%80%D0%B0-%D0%B7%D0%B0%D0%B3%D0%BE%D1%80%D0%B0/' },
    { name: 'Казанлък', url: 'http://avarii.wik-stz.com/2015/08/06/%D1%80%D0%B0%D0%B9%D0%BE%D0%BD-%D0%BA%D0%B0%D0%B7%D0%B0%D0%BD%D0%BB%D1%8A%D0%BA/' },
    { name: 'Чирпан', url: 'http://avarii.wik-stz.com/2015/08/06/%D1%80%D0%B0%D0%B9%D0%BE%D0%BD-%D1%87%D0%B8%D1%80%D0%BF%D0%B0%D0%BD/' },
    { name: 'Раднево', url: 'http://avarii.wik-stz.com/2015/08/06/%D1%80%D0%B0%D0%B9%D0%BE%D0%BD-%D1%80%D0%B0%D0%B4%D0%BD%D0%B5%D0%B2%D0%BE/' }
  ];

  const DATE_HEADER_RE = /(\d{1,2})\.(\d{1,2})\.(\d{4})/;
  const TIME_RANGE_RE = /(\d{1,2}):(\d{2})\s*\/\s*(\d{1,2}):(\d{2})/;
  const MAX_AGE_DAYS = 3;
  const now = new Date();

  let totalFound = 0;
  let totalParsed = 0;
  let totalSaved = 0;

  for (const district of districts) {
    try {
      const res = await axios.get(district.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 8000
      });
      const $ = cheerio.load(res.data);
      const rows = $('table tr').toArray();

      let currentDate = null;
      let stop = false;

      for (const row of rows) {
        if (stop) break;
        const $row = $(row);
        const tds = $row.find('td');

        if (tds.length === 1 && $(tds[0]).attr('colspan')) {
          const headerText = $(tds[0]).text().trim();
          const m = headerText.match(DATE_HEADER_RE);
          if (m) {
            const d = parseInt(m[1], 10);
            const mo = parseInt(m[2], 10) - 1;
            const y = parseInt(m[3], 10);
            const rowDateUtc = Date.UTC(y, mo, d);
            const nowUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
            if ((nowUtc - rowDateUtc) / 86400000 > MAX_AGE_DAYS) {
              stop = true;
              currentDate = null;
              continue;
            }
            currentDate = { y, m: mo, d };
          }
          continue;
        }

        if (!currentDate || tds.length < 2) continue;

        const timeText = $(tds[0]).text().trim();
        const desc = $(tds[1]).text().trim();
        if (!desc || desc.length < 10) continue;
        totalFound++;

        const timeMatch = timeText.match(TIME_RANGE_RE);
        const startH = timeMatch ? parseInt(timeMatch[1], 10) : 8;
        const startM = timeMatch ? parseInt(timeMatch[2], 10) : 0;
        const endH = timeMatch ? parseInt(timeMatch[3], 10) : 17;
        const endM = timeMatch ? parseInt(timeMatch[4], 10) : 0;

        const offset = getBulgariaUtcOffsetHours(currentDate.y, currentDate.m, currentDate.d);
        const startTime = new Date(Date.UTC(currentDate.y, currentDate.m, currentDate.d, startH - offset, startM, 0));
        let endTime = new Date(Date.UTC(currentDate.y, currentDate.m, currentDate.d, endH - offset, endM, 0));
        if (endTime.getTime() <= startTime.getTime()) endTime = new Date(endTime.getTime() + 24 * 3600000);

        let status = 'active';
        if (endTime.getTime() <= now.getTime()) status = 'resolved';
        else if (startTime.getTime() > now.getTime()) status = 'scheduled';
        // See scrapeSofiaWaterGis()/scrapeElektroholdLivePower() for why:
        // a row already resolved by the time it's first seen has no
        // active/scheduled row to match against and would re-insert
        // forever instead of converging.
        if (status === 'resolved') continue;

        totalParsed++;
        const affected_streets = extractStreetsHeuristic(desc);
        const dateLabel = `${String(currentDate.d).padStart(2, '0')}.${String(currentDate.m + 1).padStart(2, '0')}.${currentDate.y}`;
        const raw_location_text = `ВиК Стара Загора (район ${district.name}) — ${dateLabel} г., ${timeText} ч.: ${desc}`;

        await upsertOrCollect({
          utility_type: 'water',
          provider: 'ВиК Стара Загора',
          city: district.name,
          region: 'Стара Загора',
          raw_location_text,
          affected_streets: affected_streets.length > 0 ? affected_streets : [district.name],
          source_url: district.url,
          start_time: startTime.toISOString(),
          expected_end_time: endTime.toISOString(),
          status,
          source_announcement_key: `wikstz:${district.name}:${dateLabel}:${timeText}:${desc.slice(0, 80)}`
        }, dryRun, dryRunCandidates);
        totalSaved++;
      }
    } catch (e) {
      console.warn(`ВиК Стара Загора scraping error for ${district.name}:`, e.message);
    }
  }

  await logAndRecordScraperStats('ВиК Стара Загора', { found: totalFound, parsed: totalParsed, saved: totalSaved });
  return totalSaved;
}

/**
 * Dedicated Real-Time Scraper for ERP Sever (All 9 Northern Bulgarian Provinces)
 */
export async function scrapeErpSeverLivePower(dryRun = false, dryRunCandidates = null) {
  console.log('⚡ [ERP SEVER] Fetching live power outages for Northern Bulgaria...');
  const regions = [
    { id: 1, name: 'Варна' },
    { id: 2, name: 'Велико Търново' },
    { id: 3, name: 'Габрово' },
    { id: 4, name: 'Добрич' },
    { id: 5, name: 'Разград' },
    { id: 6, name: 'Русе' },
    { id: 7, name: 'Силистра' },
    { id: 8, name: 'Търговище' },
    { id: 9, name: 'Шумен' }
  ];

  let totalParsed = 0;
  // Regions whose whole feed was fetched and processed without a single error — the
  // only ones where "not listed any more" can be trusted (see closeVanishedOutages).
  const passStartedAt = Date.now();
  const completeRegionPrefixes = [];

  for (const reg of regions) {
    try {
      const url = `https://erpsever.bg/bg/profil/xhr/?method=get_interruptions&region_id=${reg.id}&type=all_active&offset=0`;
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://erpsever.bg/bg/prekysvanija'
        },
        timeout: 8000
      });

      // Not a feed at all (an error page, a block) — never read as "nothing listed".
      if (!Array.isArray(res.data)) continue;
      const areaData = res.data.find(a => a.area_id == reg.id);
      const locations = areaData && Array.isArray(areaData.area_locations) ? areaData.area_locations : [];

      for (const loc of locations) {
        // ЕРП Север stamps every individual announcement with a "Публикувано
        // на DD.MM.YYYY HH:MM" line — REVERTED the earlier assumption that
        // this alone is unique per announcement. Confirmed live: three
        // genuinely different real bulletins for Велико Търново (Горна
        // Оряховица streets, one Свищов village group, a second Свищов
        // village group — different dates, different content) all carried
        // the EXACT SAME "Публикувано на 14.09.2026 16:09" — their system
        // evidently batch-publishes multiple separate announcements under
        // one shared timestamp, only down to the minute. Using that alone
        // as an exact-match key meant upsertOutage() treated all three as
        // "the same announcement" and union-merged their street lists
        // together — the exact cross-contamination bug this key was built
        // to prevent, just from a different cause. Combines the timestamp
        // with the announcement's own period text and a content slice
        // (same robust pattern already used for EVN's key below, which has
        // no publish timestamp at all) so a batch-time collision alone can
        // no longer make two genuinely different bulletins match. Captured
        // BEFORE cleanOutageAnnouncementText/tag-stripping, which would
        // otherwise discard the publish-timestamp line as boilerplate.
        const publishedMatch = (loc.location_text || '').match(/Публикувано на ([\d.]+ [\d:]+)/);
        const periodText = (loc.location_period || '').replace(/<[^>]*>/g, '').trim();
        // Full text, not a short slice — confirmed live even a 120-char
        // slice still collided for entries sharing both the same batch
        // publish-timestamp AND the same opening boilerplate sentence
        // ("Поради неотложни ремонтни дейности..."), differing only in the
        // specific village/street list further into the text. Postgres TEXT
        // has no meaningful length concern here, and only byte-identical
        // full announcements should ever collide now (which would mean
        // they really are the same one).
        const contentSlice = (loc.location_text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const announcementKey = publishedMatch
          ? `erpsever:${reg.id}:${publishedMatch[1]}:${periodText}:${contentSlice}`
          : null;

        const rawText = cleanOutageAnnouncementText(`${loc.location_period || ''} ${loc.location_text || ''}`.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
        if (!rawText || rawText.length < 15) continue;

        const parsed = parseOutageTextHeuristic(rawText, 'Енерго-Про (ЕРП Север)', reg.name, 'https://erpsever.bg/bg/prekysvanija');
        // Readable case and the registry's spelling; a village the registry does not know keeps the name read.
        const labeled = relabelEvnSettlement({ ...parsed, city: parsed.city || reg.name }, reg.name, { provinceFallback: false });

        await upsertOrCollect({
          utility_type: 'electricity',
          provider: 'Енерго-Про (ЕРП Север)',
          city: labeled.city,
          region: reg.name,
          raw_location_text: rawText,
          affected_streets: labeled.affected_streets,
          source_url: 'https://erpsever.bg/bg/prekysvanija',
          start_time: parsed.start_time,
          expected_end_time: parsed.expected_end_time,
          status: parsed.status,
          source_announcement_key: announcementKey
        }, dryRun, dryRunCandidates);
        totalParsed++;
      }
      completeRegionPrefixes.push(`erpsever:${reg.id}:`);
    } catch (e) {
      console.warn(`ERP Sever scraping error for ${reg.name}:`, e.message);
    }
  }

  if (!dryRun) {
    await closeVanishedOutages({ provider: 'Енерго-Про (ЕРП Север)', keyPrefixes: completeRegionPrefixes, passStartedAt })
      .catch((e) => console.warn('ERP Sever sync error:', e.message));
  }

  console.log(`✅ [ERP SEVER] Processed ${totalParsed} live power outages across Northern Bulgaria.`);
  await recordScraperRun('Енерго-Про (ЕРП Север)', { found: totalParsed, parsed: totalParsed, saved: totalParsed });
  return totalParsed;
}

/**
 * The registry settlement a scraped name refers to inside a province, even when the source glued
 * something onto it ("Добрич- улици", "Добрич ИДИС АД", "Каварна по", "Слънчев Бряг Общежитие
 * Лале"): tries the whole name, then ever shorter leading word groups (at most 3 words).
 */
export function registrySettlement(rawName, provinceName) {
  // "М.Чинка" / "Г. Кабда" — an abbreviated first word (the dots are lost in the word split below).
  const abbreviated = expandAbbreviatedSettlementName(rawName, provinceName);
  if (abbreviated) {
    const found = getSettlementCoordinates(abbreviated, '', provinceName);
    if (found && !found.isRegionFallback && found.name && found.lat && found.lng) return found;
  }
  const words =String(rawName || '').replace(/[.,;:]+/g, ' ').replace(/\s*[-–—]\s*/g, ' ').trim().split(/\s+/).filter(Boolean);
  for (let n = Math.min(words.length, 3); n >= 1; n--) {
    const found = getSettlementCoordinates(words.slice(0, n).join(' '), '', provinceName);
    if (found && !found.isRegionFallback && found.name && found.lat && found.lng) return found;
  }
  return null;
}

// Technical abbreviations that stay in capitals when EVN's ALL-CAPS text is made readable.
const KEEP_UPPER_WORDS = new Set(['ТП', 'БКТП', 'МТП', 'СТП', 'ЕТ', 'ПС', 'ВЕЦ', 'ТКЗС', 'НН', 'СН', 'ВН', 'ДАП', 'АЕЦ']);

/**
 * EVN writes many addresses entirely in capitals ("УЛ. ВАСИЛ ЛЕВСКИ", "С. ЦЕРКОВСКИ",
 * "ул. Д-Р БОГОРОВ"). Shows the name part in normal case ("ул. Васил Левски") so the
 * popup reads like the rest of the site; matching lower-cases everything anyway.
 * Entries whose name part already has lower-case letters are returned untouched.
 */
export function humanizeCapsEntry(entry) {
  const s = String(entry || '').trim();
  const m = s.match(/^((?:ул|бул|кв|гр|с|пл|жк|ж\.к)\.?|село|квартал|улица|град)(?=[\s.]|$)\.?\s*(.*)$/i);
  const rest = m ? m[2] : s;
  if (!rest || /[а-яa-z]/.test(rest) || !/[А-ЯA-Z]{3}/.test(rest)) return entry;
  const words = rest.toLowerCase()
    .replace(/(^|[\s\-.("„«])([а-яa-z])/g, (_, before, ch) => before + ch.toUpperCase())
    .replace(/(?<![а-яА-Я])([А-Я][а-я]{1,4})(?![а-яА-Я])/g, (w) => (KEEP_UPPER_WORDS.has(w.toUpperCase()) ? w.toUpperCase() : w));
  if (!m) return words;
  let prefix = m[1].toLowerCase();
  if (/^(?:ул|бул|кв|гр|с|пл)$/.test(prefix)) prefix += '.';
  return `${prefix} ${words}`;
}

/**
 * EVN's table has no settlement column, so every notice used to be filed under its
 * PROVINCE name ("Кърджали" for a notice about "С. ВРАНСКО, С. РЕЧНИЦИ"): the map
 * popup then read "гр. Кърджали" under a village name, and a resident of that
 * village never matched it by city. Gives a notice its real settlement — the
 * parser's city when the registry confirms it inside this province, otherwise the
 * province as before — and the canonical spelling/type ("с. Церковски") for every
 * settlement entry, since EVN writes them in capitals.
 */
export function relabelEvnSettlement(parsed, provinceName, { provinceFallback = true } = {}) {
  const affected_streets = (parsed.affected_streets || []).map((rawEntry) => {
    let entry = humanizeCapsEntry(rawEntry);
    // "гр. Китен - изключване", "с. Люляк - без захранване": a settlement entry
    // followed by a dash and the notice's own wording is just the settlement.
    const cut = String(entry).match(/^((?:с\.|село|гр\.|град)\s+[^-–—]+?)\s+[-–—]\s+\S.*$/i);
    if (cut) entry = cut[1].trim();
    // "кв. Самара-БКТП Дедов": the substation belongs to the notice, not to the quarter's name.
    entry = String(entry).replace(/([А-Яа-я])\s*[-–]\s*(?:БКТП|МТП|СТП|ТП)(?![А-Яа-я]).*$/, '$1').trim();
    // A whole-municipality notice ("… на територията на Община Девин") is about that municipality's seat.
    const muni = String(entry).match(/територията на\s+Община\s+([А-Я][а-я]+(?:\s[А-Я][а-я]+)?)/i);
    if (muni) {
      const seat = getSettlementCoordinates(muni[1], '', provinceName);
      if (seat && !seat.isRegionFallback && seat.name) return `${seat.type === 'гр.' ? 'гр.' : 'с.'} ${seat.name}`;
    }
    const m = String(entry).match(/^(с\.|село|гр\.|град)\s+(.+)$/i);
    if (!m) return entry;
    const found = registrySettlement(m[2], provinceName);
    return found ? `${found.type === 'гр.' ? 'гр.' : 'с.'} ${found.name}` : entry;
  });
  let city = parsed.city || provinceName;
  if (city !== provinceName) {
    const found = registrySettlement(city, provinceName);
    if (found) city = found.name;
    else if (provinceFallback) city = provinceName;
    else city = humanizeCapsEntry(city); // ЕРП Север keeps the name it read, in readable case
  }
  return { city, affected_streets };
}

/**
 * Dedicated Real-Time Scraper for EP Yug / EVN (All 9 Southern Bulgarian Provinces)
 */
export async function scrapeElYugLivePower(dryRun = false, dryRunCandidates = null) {
  console.log('⚡ [EP YUG] Fetching live power outages for Southern Bulgaria...');
  const regions = [
    { id: 4, name: 'Пловдив', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung4.asp' },
    { id: 1, name: 'Бургас', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung1.asp' },
    { id: 7, name: 'Стара Загора', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung7.asp' },
    { id: 3, name: 'Пазарджик', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung3.asp' },
    { id: 5, name: 'Сливен', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung5.asp' },
    { id: 8, name: 'Хасково', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung8.asp' },
    { id: 9, name: 'Ямбол', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung9.asp' },
    { id: 6, name: 'Смолян', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung6.asp' },
    { id: 2, name: 'Кърджали', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung2.asp' }
  ];

  let totalParsed = 0;
  // See scrapeErpSeverLivePower(): only regions fetched and processed without any
  // error count as "complete" for closing announcements the source dropped.
  const passStartedAt = Date.now();
  const completeRegionPrefixes = [];

  for (const reg of regions) {
    try {
      const res = await axios.get(reg.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        responseType: 'arraybuffer',
        timeout: 8000
      });
      const html = iconv.decode(res.data, 'windows-1251');
      const $ = cheerio.load(html);

      let currentAddresses = '';
      let currentTime = '';
      let currentDate = '';

      // Cheerio's .each() is synchronous and doesn't await an async callback —
      // passing one here meant later rows ran (and overwrote these shared
      // variables) before an earlier row's `await upsertOutage(...)` had even
      // resolved, and any rejection became an unhandled promise rejection
      // (Node crashes the process on those by default). Collect the parsed
      // announcements synchronously first, then upsert them in a real,
      // sequential, individually-guarded loop.
      const pendingAnnouncements = [];
      $('tr').each((_, tr) => {
        const text = $(tr).text().replace(/\s+/g, ' ').trim();
        if (text.includes('Адрес(и) |') || text.startsWith('Адрес(и)')) {
          currentAddresses = text.replace(/Адрес\(и\)\s*\|?\s*/i, '').trim();
        }
        if (text.includes('Срок на изключването от / до |') || text.startsWith('Срок на изключването')) {
          currentTime = text.replace(/Срок на изключването от \/ до\s*\|?\s*/i, '').trim();
        }
        if (text.includes('Дата(и) на изключването |') || text.startsWith('Дата(и) на изключването')) {
          currentDate = text.replace(/Дата\(и\) на изключването\s*\|?\s*/i, '').trim();

          if (currentAddresses && currentAddresses.length > 10) {
            pendingAnnouncements.push({ addresses: currentAddresses, time: currentTime, date: currentDate });
          }
          currentAddresses = '';
          currentTime = '';
          currentDate = '';
        }
      });

      let regionHadErrors = false;
      for (const announcement of pendingAnnouncements) {
        try {
          const rawAnnouncement = cleanOutageAnnouncementText(`Планирано изключване на електрозахранването в Област ${reg.name}. Дата: ${announcement.date}. Час: ${announcement.time}. Адреси: ${announcement.addresses}`);
          const parsed = parseOutageTextHeuristic(rawAnnouncement, 'EVN България', reg.name, reg.url);
          const labeled = relabelEvnSettlement(parsed, reg.name);

          // elyug.bg's table has no per-announcement id/publish-timestamp
          // (unlike ЕРП Север's feed — see scrapeErpSeverLivePower()), but
          // its own three raw fields (address text, time range, date range)
          // are effectively a natural fingerprint: two genuinely different
          // announcements essentially never share all three verbatim, while
          // the SAME announcement re-scraped always repeats them identically.
          // Same purpose and payoff as ЕРП Север's key — confirmed live,
          // street-overlap-only matching here undercounted just as badly
          // (e.g. Пловдив: 2 stored vs. 11 actually on the source page).
          const announcementKey = `evn:${reg.id}:${announcement.date}|${announcement.time}|${announcement.addresses}`;

          await upsertOrCollect({
            utility_type: 'electricity',
            provider: 'EVN България',
            city: labeled.city,
            region: reg.name,
            raw_location_text: rawAnnouncement,
            affected_streets: labeled.affected_streets,
            source_url: reg.url,
            start_time: parsed.start_time,
            expected_end_time: parsed.expected_end_time,
            status: parsed.status,
            source_announcement_key: announcementKey
          }, dryRun, dryRunCandidates);
          totalParsed++;
        } catch (e) {
          regionHadErrors = true;
          console.warn(`EP Yug upsert error for ${reg.name}:`, e.message);
        }
      }
      // An empty parse is more likely a changed/broken page than a region with
      // nothing scheduled, so it is never trusted to close anything.
      if (!regionHadErrors && pendingAnnouncements.length > 0) completeRegionPrefixes.push(`evn:${reg.id}:`);
    } catch (e) {
      console.warn(`EP Yug scraping error for ${reg.name}:`, e.message);
    }
  }

  if (!dryRun) {
    await closeVanishedOutages({ provider: 'EVN България', keyPrefixes: completeRegionPrefixes, passStartedAt })
      .catch((e) => console.warn('EP Yug sync error:', e.message));
  }

  console.log(`✅ [EP YUG] Processed ${totalParsed} live power outages across Southern Bulgaria.`);
  await recordScraperRun('EVN България', { found: totalParsed, parsed: totalParsed, saved: totalParsed });
  return totalParsed;
}

/**
 * Dedicated Real-Time AI Scraper Engine for Bulgarian Gas Distribution Companies (Овергаз, Аресгаз, Ситигаз, Балкангаз)
 */
export async function scrapeBulgarianGasUtilitiesLive(dryRun = false, dryRunCandidates = null) {
  console.log('⛽ [GAS UTILITIES] Fetching live gas outages and maintenance across Bulgaria...');
  let totalParsed = 0;

  // 1. Official Direct Overgas GIS ArcGIS FeatureServer
  try {
    const gisRes = await axios.get('https://gisportal.overgas.bg/arcgis/rest/services/OVERGAS_PUBLIC/PublicInterruption/MapServer/0/query?where=1%3D1&outFields=*&f=json', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      timeout: 7000
    });
    if (gisRes.data && Array.isArray(gisRes.data.features) && gisRes.data.features.length > 0) {
      console.log(`🗺️ [OVERGAS GIS] Found ${gisRes.data.features.length} live GIS outages in Overgas network.`);
      for (const feat of gisRes.data.features) {
        const attr = feat.attributes || {};
        const desc = attr.interruptiondescription || 'Планирано спиране на газоподаването по газоразпределителната мрежа';
        const restoreTime = attr.expectedrestoretime ? new Date(attr.expectedrestoretime).toISOString() : new Date(Date.now() + 4 * 3600000).toISOString();
        const city = attr.servicecenter ? `Сервизен център ${attr.servicecenter}` : 'София';
        
        await upsertOrCollect({
          utility_type: 'gas',
          provider: 'Овергаз Мрежи',
          city: city,
          raw_location_text: desc,
          affected_streets: [desc],
          source_url: 'https://www.overgas.bg/planirani-remonti-i-avarii/',
          start_time: new Date().toISOString(),
          expected_end_time: restoreTime,
          status: 'active'
        }, dryRun, dryRunCandidates);
        totalParsed++;
      }
    }
  } catch (e) {
    console.warn('Overgas GIS query error:', e.message);
  }

  const gasTargets = [
    {
      provider: 'Аресгаз',
      city: 'Плевен',
      url: 'https://www.aresgas.bg/infocenter/'
    },
    {
      provider: 'Аресгаз',
      city: 'Враца',
      url: 'https://www.aresgas.bg/infocenter/'
    },
    {
      provider: 'Аресгаз',
      city: 'Благоевград',
      url: 'https://www.aresgas.bg/infocenter/'
    }
  ];

  let gasFetchCount = 0;
  for (const target of gasTargets) {
    gasFetchCount++;
    if (gasFetchCount > 1) await sleep(THROTTLE_DELAY_MS);
    try {
      const res = await axios.get(target.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: 6000
      });

      // Same fused-text risk as scrapeProviderTargetItems's Strategy A (see
      // its own htmlWithBlockSpacing comment) — Cheerio's .text() inserts no
      // separator at tag boundaries, so a source with no whitespace between
      // adjacent block tags would glue two fields into one word here too.
      const htmlWithBlockSpacing = (typeof res.data === 'string' ? res.data : String(res.data))
        .replace(/<\/(p|div|li|h[1-6]|tr|td|article|section|header|footer)>/gi, '</$1> ')
        .replace(/<br\s*\/?>/gi, ' ');
      const $ = cheerio.load(htmlWithBlockSpacing);
      const items = [];

      $('article, .news-item, .post, .entry, .card, li, p').each((_, el) => {
        const txt = $(el).text().replace(/\s+/g, ' ').trim();
        const txtLower = txt.toLowerCase();
        if (txt.length > 25 && (
          txtLower.includes('газопровод') ||
          txtLower.includes('газоподаване') ||
          txtLower.includes('природен газ') ||
          txtLower.includes('профилактика') ||
          txtLower.includes('ремонт') ||
          txtLower.includes('присъединяване')
        )) {
          const cleanTxt = cleanOutageAnnouncementText(txt);
          if (isAnnouncementIndicatingNoOutage(cleanTxt)) return; // Skip "No outages" disclaimers

          const link = $(el).find('a').attr('href') || target.url;
          if (!items.some(it => it.text.substring(0, 40) === cleanTxt.substring(0, 40))) {
            items.push({ text: cleanTxt, url: link.startsWith('http') ? link : `${target.url}${link}` });
          }
        }
      });

      for (const item of items.slice(0, 2)) {
        const parsed = await throttledAiParse(item.text, target.provider, target.city, item.url);
        if (parsed && parsed.status !== 'resolved') {
          await upsertOrCollect({
            ...parsed,
            utility_type: 'gas',
            region: parsed.region || target.city
          }, dryRun, dryRunCandidates);
          totalParsed++;
        }
      }
    } catch (e) {
      // Graceful fallback
    }
  }

  console.log(`✅ [GAS UTILITIES] Processed ${totalParsed} live gas outage/maintenance records.`);
  await recordScraperRun('Газови дружества (общо)', { found: totalParsed, parsed: totalParsed, saved: totalParsed });
  return totalParsed;
}

/**
 * Scrapes outage announcements from major Bulgarian utility provider websites,
 * parses raw texts with Google Gemini AI Parser, and upserts into database.
 */
let lastRunAt = null;
let lastRunCount = 0;

export function getScraperStatus() {
  return { last_run_at: lastRunAt, last_run_count: lastRunCount };
}

// Admin "preview before commit" audit flow — see runScraperJob(dryRun) for
// how candidates are collected. Fire-and-forget + poll, same pattern as
// url-health/run and source-audit/run: a full dry run touches every
// provider (same as a real scrape cycle) and can take several minutes, so
// this can't be a single synchronous request/response.
let dryRunAuditState = { inProgress: false, ranAt: null, candidates: [], totalChecked: 0, error: null };

export function getDryRunAuditState() {
  return dryRunAuditState;
}

/**
 * Step 2 of the admin preview/approval flow — takes the subset of
 * candidates the admin actually checked in the modal (sent back by the
 * frontend, since it already holds the full dry-run result client-side —
 * no server-side batch storage/expiry needed) and writes each one for
 * real via the exact same upsertOutage() every live scraper uses. Each
 * call re-does its own fresh existing-row lookup against the CURRENT
 * database (not the dry run's now-possibly-stale snapshot) — safe even if
 * a real scrape cycle already picked up the same announcement in the
 * meantime, since that just becomes an UPDATE instead of a duplicate
 * insert (same idx_outages_active_dedup constraint every other write
 * path relies on).
 */
export async function commitApprovedCandidates(candidates) {
  let committed = 0;
  const errors = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    try {
      await upsertOutage(candidate, { dryRun: false });
      committed++;
    } catch (err) {
      errors.push({ candidate: candidate?.raw_location_text?.slice(0, 80), error: err.message });
    }
  }
  return { committed, errors };
}

// ---------------------------------------------------------------------
// Manual entry for a provider whose site can't be scraped — refuses our
// server (Топлофикация Русе's Cloudflare challenge, Топлофикация Бургас's
// "access limited"), is down, or crashes. The admin reads the provider's
// public announcement in their own browser and pastes the text; it goes
// through the SAME cleaning, parsing, geocoding and duplicate matching a
// scraped announcement does, and the admin approves it in the existing
// approval modal before anything is written. Nothing here contacts the
// provider's site or gets around any protection.
// ---------------------------------------------------------------------
export function listManualAnnouncementProviders() {
  return PROVIDER_TARGETS.map((t) => ({ provider: t.provider, city: t.city, utility_type: t.defaultUtility || null }));
}

/**
 * PREVIEW only — never writes. Resolves to `{ ok, action?, candidate?, parsed?, message }`
 * where `candidate` (present only for a genuinely new, still-relevant outage) is exactly the
 * object /api/admin/commit-sync expects.
 */
export async function previewManualAnnouncement({ provider, city, text, sourceUrl } = {}) {
  const target = PROVIDER_TARGETS.find((t) => t.provider === provider);
  if (!target) return { ok: false, message: 'Непознат доставчик — избери от списъка.' };

  const raw = String(text || '').trim();
  if (raw.length < 20) return { ok: false, message: 'Текстът е твърде кратък — постави цялото съобщение.' };
  if (raw.length > 8000) return { ok: false, message: 'Текстът е твърде дълъг (над 8000 знака) — постави само едно съобщение.' };

  const link = String(sourceUrl || '').trim();
  if (link && !/^https?:\/\/\S+$/i.test(link)) return { ok: false, message: 'Връзката трябва да започва с http:// или https://.' };

  const cleaned = cleanOutageAnnouncementText(raw);
  if (isAnnouncementIndicatingNoOutage(cleaned)) {
    return { ok: false, message: 'Текстът прилича на „няма аварии" или меню на сайт, а не на съобщение за авария.' };
  }

  const cityName = String(city || '').trim() || target.city;
  const structured = await parseOutageTextWithAI(cleaned, provider, cityName, link || target.url);
  const payload = {
    ...structured,
    utility_type: structured.utility_type || target.defaultUtility,
    source_announcement_key: link ? `manual:${link}` : null,
    region: structured.region || target.region || (target.regionUnknown ? '' : target.city)
  };

  const result = await upsertOutage(payload, { dryRun: true });
  const parsed = {
    provider: payload.provider,
    city: payload.city,
    utility_type: payload.utility_type,
    affected_streets: payload.affected_streets || [],
    start_time: payload.start_time,
    expected_end_time: payload.expected_end_time,
    status: payload.status
  };

  if (result.action === 'update') {
    return { ok: true, action: 'update', parsed, message: 'Тази авария вече е записана — няма какво да се добавя (край на времето се опреснява от скрейпъра).' };
  }
  if (result.action === 'duplicate_resolved') {
    return { ok: true, action: 'duplicate_resolved', parsed, message: 'Тази авария вече е записана и е приключила.' };
  }
  if (result.status === 'resolved') {
    return { ok: true, action: 'expired', parsed, message: 'Съобщението е за минал период — на картата се показват само текущи и предстоящи аварии.' };
  }
  return { ok: true, action: 'new', candidate: result, parsed, message: 'Готово за одобрение.' };
}

export async function runDryRunAudit() {
  if (dryRunAuditState.inProgress) return dryRunAuditState;
  dryRunAuditState = { ...dryRunAuditState, inProgress: true, error: null };
  try {
    const result = await runScraperJob(true);
    dryRunAuditState = {
      inProgress: false,
      ranAt: new Date().toISOString(),
      candidates: result.candidates || [],
      totalChecked: result.totalChecked || 0,
      error: null
    };
  } catch (err) {
    dryRunAuditState = { ...dryRunAuditState, inProgress: false, error: err.message };
  }
  return dryRunAuditState;
}

// Scrapes and extracts candidate outage text items for ONE PROVIDER_TARGETS
// entry — the exact fetch + Strategy A/B/C extraction + fake-announcement
// filter runScraperJob() itself uses. Extracted into its own function so the
// admin-triggered source-content audit (sourceAuditService.js) exercises
// the SAME real logic instead of a separately-maintained copy that could
// silently drift out of sync with future changes here — confirmed the hard
// way earlier: a throwaway audit script with its own copy of this logic
// produced a false alarm the real pipeline didn't have.
/**
 * ВиК Добрич publishes ONE list for the whole province — "- Район Добрич: …; - Район Добрич-селска:
 * с. Дебрене …; - Район Балчик: гр. Балчик - ул. П. Яворов …; - Район Каварна: …" — and the page
 * yields both that whole list and each район line as separate items. Stored as-is it became one row
 * with the streets of six unrelated areas under a single city (a Добрич-област list filed under
 * "Балчик"), plus overlapping copies. Each район becomes its own item, keyed by the район's name,
 * so a village of Каварна is not pinned in Балчик and the city label is that район's own.
 */
// A paragraph that ends on a preposition/conjunction continues in the next element.
export const DANGLING_END_RE = /(?:^|\s)(?:в|на|по|до|от|за|при|със?|и|около|между)$/i;

export function splitRegionItems(items, target) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const parts = String(item.text || '').split(/(?:^|\s)-\s*(?=Район\s)/).map((x) => x.trim()).filter(Boolean);
    const rajons = parts.filter((x) => /^Район\s/.test(x));
    if (rajons.length === 0) { out.push(item); continue; }
    for (const part of rajons) {
      const name = (part.match(/^Район\s+([^:]{2,40}):/) || [])[1];
      if (!name) continue;
      const key = name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // The closing courtesy paragraph belongs to no район.
      const text = part.replace(/\s*С настоящото съобщение[\s\S]*$/i, '').trim();
      if (text.length < 20) continue;
      out.push({ ...item, text: `- ${text}`, sourceUrl: `${target.url}?item=${encodeURIComponent(`rajon-${key.replace(/\s+/g, '-')}`)}` });
    }
  }
  return out;
}

/**
 * Whether the scraper may open an article link found on a provider's page. Only links on the provider's OWN site:
 * the same host (www. ignored) or a sub-/parent domain of it (avarii.wik-stz.com for wik-stz.com), over http/https,
 * without credentials in the URL. The page's HTML is not under our control — ВиК Търговище's links point at its
 * internal server http://10.10.0.7/ — and a link followed blindly lets a page (or anyone who can inject into it)
 * make this server request internal addresses, a cloud metadata address or another service, and whatever comes back
 * could be published on the map as an "outage" text.
 */
export function isFollowableArticleLink(link, targetUrl, extraHosts = []) {
  let u;
  let t;
  try { u = new URL(link); t = new URL(targetUrl); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const base = t.hostname.toLowerCase().replace(/^www\./, '');
  if (!host || !base) return false;
  if (host === base || host.endsWith('.' + base) || base.endsWith('.' + host)) return true;
  // A provider whose own page links to its OTHER domain (toplo.sliven.net -> toplosliven.com) lists that host in
  // its target as followHosts — an explicit, reviewed exception, never inferred from the page.
  return extraHosts.some((h) => host === String(h).toLowerCase().replace(/^www\./, ''));
}

export async function scrapeProviderTargetItems(target, { force = false } = {}) {
  let scrapedItems = [];
  let fetchInfo = null;

  lastScrapeNote.delete(target.provider);
  const failure = scrapeFailureState.get(target.provider);
  if (!force && failure && failure.skipUntil > Date.now()) {
    lastScrapeNote.set(target.provider, `пауза до ${new Date(failure.skipUntil).toISOString().slice(11, 16)} UTC след ${failure.fails} поредни неуспешни връзки (${failure.lastError})`);
    return [];
  }

  try {
      // 1. Attempt live HTTPS fetch — retries transient failures (see
      // fetchWithRetry) up to 3x with exponential backoff before giving up.
      const response = await fetchWithRetry(target.url, {
        headers: buildRequestHeaders(target),
        // target.timeout lets a specific slow-but-real site opt into more
        // than the default 8s — confirmed live for energy-varna.bg (Veolia
        // Варна): it isn't blocked or broken, it just routinely takes
        // 10-15s to respond, so the default was timing out on a perfectly
        // real, reachable site every single scrape cycle.
        timeout: target.timeout || 8000,
        // A provider that has explicitly refused us is always contacted directly,
        // never through the optional proxy (see utils/egress.js).
        ...(target.noProxy ? directAgents : {})
      }, target.probeEveryCycle ? 0 : 3);

      // Cheerio's .text() concatenates every descendant text node with
      // ZERO separator at tag boundaries — it only preserves whitespace
      // that's already literally present in the source HTML, unlike a real
      // browser's innerText which inserts line breaks at block elements.
      // Confirmed live: ВиК София област's own markup has no whitespace at
      // all between adjacent block tags — literally
      // "...с. Рельово</p>Предполагаемо време за отстраняване: ..." — so
      // .text() on that article produced "рельовопредполагаемо" as one
      // fused word, which then got parsed as if it were the village's own
      // name. Every provider scraped through this shared function is
      // exposed to the same risk any time its own markup happens to omit
      // whitespace between tags, so the fix is general: force a real space
      // after every common block-closing tag before Cheerio ever runs, so
      // .text() can no longer glue two elements' content together. Purely
      // additive whitespace — .replace(/\s+/g, ' ') further down already
      // collapses any run of spaces this creates back to one, so this can
      // only ever separate previously-fused text, never change output for
      // a page that already had proper spacing.
      scrapeFailureState.delete(target.provider);
      {
        const rawHtml = typeof response.data === 'string' ? response.data : String(response.data);
        fetchInfo = {
          status: response.status,
          bytes: rawHtml.length,
          title: ((rawHtml.match(/<title[^>]*>([^<]{0,120})/i) || [])[1] || '').replace(/\s+/g, ' ').trim(),
          html: rawHtml
        };
      }

      const htmlWithBlockSpacing = (typeof response.data === 'string' ? response.data : String(response.data))
        .replace(/<\/(p|div|li|h[1-6]|tr|td|article|section|header|footer)>/gi, '</$1> ')
        .replace(/<br\s*\/?>/gi, ' ');
      const $ = cheerio.load(htmlWithBlockSpacing);

      // Strategy A: Find structured article containers (.et_pb_post, article, .news-item, .post)
      // .swiper-slide added after confirming live: ВиК Йовковци's site was
      // redesigned around a Swiper.js carousel for its news list — every
      // real announcement (12 currently) sits in its own .swiper-slide, and
      // the carousel is server-rendered (present in the raw HTML this axios
      // fetch sees, no client-side JS needed), but none of the prior
      // selectors matched it, so only whatever Strategy B/C happened to
      // catch separately got through at all.
      // .item/.list-item added after a broader structural audit of all
      // PROVIDER_TARGETS pages found two more real, currently-live gaps:
      // ВиК Русе's own JS widget markup wraps each of 20 real entries in
      // .item (confirmed live: "Босилковци, ул. Яне Сандански, авария на
      // водопровод"), and ВиК Монтана wraps each of its 10 in .list-item
      // (confirmed live: "Поради авария в село Доктор Йосифово…") — both
      // fully present in the server-rendered HTML, just unmatched by any
      // prior selector. containsOutageIndicatorKeyword() below already
      // guards against these two generic class names pulling in unrelated
      // page chrome on every other provider's page.
      // .vc_toggle added after confirming live: ВиК Ямбол's "Съобщения"
      // section is a WPBakery accordion widget — each real, current
      // announcement ("Временно прекъсване на водоснабдяването в с.
      // Веселиново, общ. Тунджа", dated, with a real time window) is its
      // own .vc_toggle, with the headline in an <h6> (not h1-h3, which the
      // title fallback below already checks) and the body in bare
      // <div dir="auto"> nodes (not <p>/.entry-content, which the body
      // selector below checks) — neither matched, but the whole-element
      // fullElementText fallback below picks up both together.
      $('article, .et_pb_post, .news-item, .post, .outage-item, .news-block, .swiper-slide, .item, .list-item, .vc_toggle').each((_, el) => {
        if ($(el).find('article, .et_pb_post, .post, .vc_toggle').length > 0) return;

        // WordPress stamps a "type-page" class on an <article> that wraps a
        // static PAGE (an About-us page, or — confirmed live for Топлофикация
        // Перник — the entire homepage itself: nav, login form, payment FAQ,
        // IBAN and all) as opposed to "type-post" for an actual individual
        // news/incident entry. A real per-incident article on the same site
        // carries "type-post" instead, so this only ever skips the
        // whole-page wrapper, never a genuine post.
        if (/\btype-page\b/.test($(el).attr('class') || '')) return;

        const linkEl = $(el).find('h2 a, .entry-title a, a').first();
        let href = linkEl.attr('href') || '';
        let title = linkEl.text().trim();

        // Some archive-style listings (e.g. ВиК София област's "Аварии"
        // page) render each incident as its own <article id="accident-NNNNN">
        // with NO internal link at all — just a plain <h2> headline and bare
        // text nodes, no <a>. Without a real href, every item on the page
        // fell back to the SAME target.url, and the dedup check below then
        // treated every item after the first as a duplicate of it — silently
        // dropping all but one real incident per page. The article's own id
        // (unique per incident) gives each one a distinct, stable sourceUrl.
        // Query string, not a "#..." fragment — confirmed live, the
        // href.includes('#') rejection a few lines below (meant for real
        // page-anchor nav links) was silently discarding EVERY ВиК София
        // област incident this exact synthetic href was built for, since
        // it also contains '#'. Every real article was extracted correctly
        // and then thrown away right here. The fingerprint-based fallback
        // further below already learned this lesson and uses '?item=' for
        // the same reason — this mirrors it instead of repeating the bug.
        const articleId = $(el).attr('id');
        if (!href && articleId) {
          href = `${target.url}?item=${encodeURIComponent(articleId)}`;
        }
        // Some sites (e.g. Кюстендилска вода's own outage feed, once pointed
        // at its real iframe source) give each entry neither a link NOR an
        // id — confirmed live: 37 real, distinct <article class="outage-
        // card"> entries, all with href=undefined AND id=undefined. Without
        // ANY distinguishing href, every one of them fell back to the exact
        // same target.url, and the same dedup collapse the articleId fix
        // above already solved for ВиК София област happened again here —
        // 37 real entries collapsed to 1. A short fingerprint of the
        // element's own text is stable across re-scrapes of the same
        // content (unlike a positional index, which shifts as new items get
        // added to the top of a list) and needs no query-string special
        // characters that the href.includes('#') skip-list below would
        // otherwise reject.
        // CONFIRMED LIVE (ВиК Русе, 2026-09-20): the naive full-text fingerprint
        // above starts with the item's OWN leading "DD.MM HH:MM - DD.MM HH:MM"
        // schedule (vik-ruse.com's own widget markup) — exactly the part of the
        // text that legitimately CHANGES as a single real, ongoing outage's own
        // window narrows or gets marked "завършен" on a later re-scrape. Since
        // this fingerprint becomes source_announcement_key (see the
        // announcementKey line below) and matchesOutage() in upsertOutage()
        // trusts a present key EXCLUSIVELY (skipping the street/date fallback
        // entirely once both sides have one), a changed fingerprint made the
        // SAME real outage look like a brand-new announcement every time its
        // schedule/status text updated — permanently orphaning the earlier row
        // (still 'active', with the stale end time) instead of updating it,
        // while ALSO inserting a fresh duplicate 'resolved' row (which then had
        // no dedup protection at all — see upsertOutage()'s existingResolved
        // check) on every subsequent scrape for as long as the source kept
        // re-listing the now-finished item. Reproduced live: one Червена вода
        // outage produced 16 duplicate resolved rows in under 3 hours this way.
        // Fixed by preferring the page's own semantic address element when one
        // exists (vik-ruse.com's <span class="address">) — the one part of the
        // item that IS the outage's actual stable identity — and otherwise
        // stripping the volatile leading date range + any resolved-status word
        // before slicing, so the fingerprint stays anchored on content that
        // doesn't change across an ordinary status update. Kept as a fallback
        // (not a replacement) for Кюстендилска вода's 37 no-href/no-id entries,
        // which this still tells apart exactly as before.
        if (!href && !articleId) {
          const addressText = $(el).find('.address').first().text().replace(/\s+/g, ' ').trim();
          const fingerprint = buildItemFingerprint(addressText, $(el).text());
          if (fingerprint) {
            href = `${target.url}?item=${encodeURIComponent(fingerprint)}`;
          }
        }
        if (!title) {
          title = $(el).find('h1, h2, h3, strong').first().text().trim();
        }

        const meta = $(el).find('.post-meta, .published, time, .date').text().replace(/\s+/g, ' ').trim();
        let body = $(el).find('.post-content, p, .entry-content, .news-text').text().replace(/\s+/g, ' ').trim();

        // The same structures above can also put the crucial detail (e.g. a
        // deadline time) as a bare text node directly inside <article>, not
        // wrapped in any of the selectors used for body — silently losing
        // it (confirmed live: ВиК София област's own deadline line sits
        // right after the matched <p> tags with no wrapper at all). Only
        // fall back to the article's full text when it's clearly richer
        // than title+body combined, to avoid pulling in unrelated nav/
        // wrapper content on the many other providers this already works
        // correctly for.
        const fullElementText = $(el).text().replace(/\s+/g, ' ').trim();
        if (fullElementText.length > body.length + title.length + 30) {
          body = fullElementText;
        }

        if (href && (href.includes('/category/') || href.includes('/author/') || href.includes('/page/') || href.includes('/tag/') || href.includes('/feed/') || href.includes('#') || href.includes('wp-content'))) {
          return;
        }

        if (href && !href.startsWith('http')) {
          try {
            const urlObj = new URL(target.url);
            href = `${urlObj.origin}${href.startsWith('/') ? '' : '/'}${href}`;
          } catch (e) {}
        }

        // Checked against title+body together, lowercased — checking body
        // alone missed real articles whose ONLY keyword occurrence was in
        // the headline itself (e.g. "Авария на водопровод..." as an <h2>,
        // with the body's own <p> tags containing just the location/time),
        // and the plain lowercase-only .includes() never matched a
        // capitalized first word of a sentence at all ("Авария..." with no
        // second, lowercase "авария" anywhere else in the same text).
        // "авари" (stem) rather than "авария" — Bulgarian plural/adjective
        // forms ("аварии", "аварийни") change the ending and don't contain
        // the singular word as a substring at all. Confirmed live: ВиК
        // Бургас's real, current, today-dated outage list sat under a
        // header reading "ВОДОПРОВОДНИ АВАРИИ..." (plural) — the singular-
        // only check rejected it outright, on top of the case-sensitivity
        // bug fixed earlier.
        // "прекъс" (stem) rather than "прекъсване" — the extremely common
        // adjective form "прекъснато/прекъсната водоподаването" (was cut
        // off) doesn't contain the noun "прекъсване" (the act of cutting
        // off) as a substring either, same class of bug as "авария" above.
        const combinedText = `${title} ${body}`;
        if (body.length > 25 && containsOutageIndicatorKeyword(combinedText)) {
          const directUrl = href || target.url;
          const cleanBody = cleanOutageAnnouncementText(`${title}${meta ? ` (${meta})` : ''}: ${body}`);
          if (!scrapedItems.some((it) => it.sourceUrl === directUrl)) {
            scrapedItems.push({
              title,
              sourceUrl: directUrl,
              text: cleanBody
            });
          }
        }
      });

      // Strategy B: Crawl specific article links (e.g. ViK VT, ViK Shumen, etc.)
      const articleLinks = [];
      $('a').each((_, el) => {
        let href = $(el).attr('href') || '';
        const linkText = $(el).text().replace(/\s+/g, ' ').trim();

        if (
          href &&
          !href.includes('#') &&
          !href.includes('/category/') &&
          !href.includes('/tag/') &&
          // Pagination pages ("/avarii/page/2/") are listings of many
          // incidents at once, never a single article. Confirmed live: the
          // ВиК София област archive's "page 2" link matched the "avarii"
          // keyword below, got followed, and its whole page (10 incidents +
          // the company's HQ address footer "гр.София, бул. Рожен №15") was
          // scraped as ONE record whose parsed city was Sofia — a fake
          // "outage in Sofia" alongside the real per-incident items Strategy
          // A had already captured correctly. Strategy A already rejects
          // "/page/" hrefs for the same reason.
          !href.includes('/page/') &&
          (
            href.includes('remont') ||
            href.includes('avarien') ||
            href.includes('planov') ||
            href.includes('avarii') ||
            linkText.includes('Авариен ремонт') ||
            linkText.includes('Планов ремонт') ||
            linkText.includes('Съобщение') ||
            linkText.includes('Прекъсване') ||
            // Some providers (e.g. ВиК Враца's dedicated outages page) list
            // real per-incident headlines ("Спряно водоподаване - 11.09.2026
            // г.") each followed by a generic read-more link ("научи повече
            // тук", or "прочети още" — ВиК Варна's own phrasing) — the
            // headline itself never matched any keyword above, so Strategy B
            // never followed these into their real per-incident pages, and
            // the whole headline list got scraped as one glob by Strategy
            // A/C instead.
            linkText.toLowerCase().includes('научи повече') ||
            linkText.toLowerCase().includes('прочети още') ||
            // Топлофикация Перник's own per-incident headlines are just
            // "Авария- 14.09.2026 г." — confirmed live: this matched none of
            // the keywords above (not "Авариен ремонт", just the bare noun),
            // AND its URL slug is percent-encoded Cyrillic ("авария-14-09-
            // 2026-г"), so it can never match the Latin href.includes(...)
            // checks either. Text-only stem match catches it without needing
            // the href at all — a real outage report was missing from the
            // app entirely until this was found and fixed.
            linkText.includes('Авария') ||
            // ВиК Пловдив's own per-incident headlines are "НАРУШЕНО
            // ВОДОПОДАВАНЕ В [village] НА [date]", linking to
            // /maintenance/view/... — confirmed live: the listing page only
            // ever shows a TRUNCATED teaser for each ("...поради .."), with
            // no time window at all, so isAnnouncementIndicatingNoOutage()
            // correctly rejected the teaser as boilerplate (no street match,
            // no time reference) even though it's a real, current outage —
            // the actual time window only exists on this linked detail page.
            // "/view/" specifically (not just "maintenance") — the bare
            // section index link (/maintenance/) also matched a looser
            // check and got followed as if it were one incident, mashing
            // every recent bulletin on the whole listing page (including a
            // year-old one) into a single record.
            href.includes('maintenance/view') ||
            linkText.toUpperCase().includes('ВОДОПОДАВАНЕ')
          )
        ) {
          if (!href.startsWith('http')) {
            try {
              const urlObj = new URL(target.url);
              href = `${urlObj.origin}${href.startsWith('/') ? '' : '/'}${href}`;
            } catch (e) {}
          }
          // A nav link back to the listing page itself can satisfy the
          // keyword checks above (e.g. ВиК Враца's own query string
          // "info=ViKavarii" contains "avarii") — following it just re-fetches
          // this same page as if it were a real individual article,
          // wasting one of the limited itemLimit slots on non-content.
          const isSelfLink = href === target.url || href.replace(/\/$/, '') === target.url.replace(/\/$/, '');
          if (!isSelfLink && !articleLinks.includes(href) && !scrapedItems.some((it) => it.sourceUrl === href)) {
            if (isFollowableArticleLink(href, target.url, target.followHosts || [])) articleLinks.push(href);
            else console.warn(`⚠️ [SCRAPER] ${target.provider} — not following a link that leaves the provider's own site: ${href.slice(0, 90)}`);
          }
        }
      });

      for (const link of articleLinks.slice(0, target.itemLimit || 3)) {
        try {
          // The bare 'Mozilla/5.0' string (no further detail) is a
          // well-known lazy-scraper signature — confirmed live: Топлофикация
          // Перник's own bot protection 403'd every single request sent
          // with exactly this header while accepting axios's own default UA
          // AND a realistic full browser UA string, and this catch block
          // swallows the error with zero logging, so a real, current outage
          // (affecting dozens of buildings) silently vanished with no signal
          // anywhere that Strategy B's link-follow was even failing. Using
          // the same realistic UA already used successfully elsewhere in
          // this file (urlHealthService.js, the other scrape functions
          // below) avoids this whole class of silent block.
          const articleRes = await axios.get(link, {
            headers: target.userAgent ? buildRequestHeaders(target) : { 'User-Agent': BROWSER_USER_AGENT },
            timeout: 5000,
            ...(target.noProxy ? directAgents : {})
          });
          // Same fused-text risk as Strategy A above (see htmlWithBlockSpacing) —
          // this is a second, independent page fetch/parse, so it needs its
          // own copy of the same fix rather than inheriting the one above.
          const articleHtmlWithBlockSpacing = (typeof articleRes.data === 'string' ? articleRes.data : String(articleRes.data))
            .replace(/<\/(p|div|li|h[1-6]|tr|td|article|section|header|footer)>/gi, '</$1> ')
            .replace(/<br\s*\/?>/gi, ' ');
          const $art = cheerio.load(articleHtmlWithBlockSpacing);
          const title = $art('h1, h2').first().text().trim();
          let body = '';
          $art('p, .content, .entry-content, article').each((_, el) => {
            const t = $art(el).text().replace(/\s+/g, ' ').trim();
            if (t.length > 20 && !body.includes(t)) body += ' ' + t;
          });

          const articleCombined = `${title} ${body}`;
          if (body.length > 25 && containsOutageIndicatorKeyword(articleCombined)) {
            const cleanText = cleanOutageAnnouncementText(`${title}: ${body.trim()}`);
            scrapedItems.push({
              title,
              sourceUrl: link,
              text: cleanText
            });
          }
        } catch (e) {
          // Was a silent no-op before — the Топлофикация Перник 403 sat
          // completely invisible for who knows how long because nothing
          // ever surfaced that Strategy B's link-follow was failing at all,
          // as opposed to the source simply having nothing new to report.
          console.warn(`⚠️ [SCRAPER] ${target.provider} — failed to fetch followed article link ${link}: ${e.message}`);
        }
      }

      // Strategy C: Check on-page text elements if no articles matched
      if (scrapedItems.length === 0) {
        $(target.selector).each((_, el) => {
          let txt = $(el).text().replace(/\s+/g, ' ').trim();
          // A sentence the CMS split across two paragraphs ("…ще бъде спряно водоподаването в" | "кв.Долно
          // Езерово по улиците …", ВиК Бургас): the place is in the NEXT element. The first half alone was
          // saved as an outage without any location ("Централна градска част").
          if (DANGLING_END_RE.test(txt)) {
            const nextTxt = $(el).next().text().replace(/\s+/g, ' ').trim();
            if (nextTxt && nextTxt.length < 600) txt = `${txt} ${nextTxt}`;
          }
          // Strategy C's keyword list used to lack "водоподаване"/"ток" (Strategy
          // A/B already had them) and "преустанов" — confirmed live: a real,
          // current ВиК Благоевград planned-outage announcement used the
          // formal synonym "преустановено водоподаването" (discontinued the
          // water supply) instead of "спряно"/"прекъснато", matching none of
          // the other keywords, and this exact provider's page structure
          // only reaches Strategy C (no <article>-like container Strategy A
          // recognizes, no per-item link for Strategy B to follow).
          if (txt.length > 30 && containsOutageIndicatorKeyword(txt)) {
            const cleanTxt = cleanOutageAnnouncementText(txt);
            if (!scrapedItems.some((it) => it.text.substring(0, 50) === cleanTxt.substring(0, 50))) {
              scrapedItems.push({ text: cleanTxt, sourceUrl: target.url });
            }
          }
        });
      }
    } catch (err) {
      // A single provider site being down/restructured shouldn't stop the
      // whole scrape run, so this stays non-fatal — but it used to swallow
      // the error with zero logging, meaning a genuinely broken target (as
      // opposed to just "no outages right now") could silently stop
      // producing outages forever with no trace anywhere to notice it by.
      console.warn(`⚠️ [SCRAPER] ${target.provider} (${target.city}) failed: ${err.message} — ${target.url}`);
      // For a refusal (403/429/5xx) also keep who answered and what they said —
      // the status code alone can't tell "their firewall blocks our server's
      // address" from "their site is down", and this is what an admin needs to
      // ask the provider to allow the server (or to see it's their outage).
      const refusal = err.response ? describeRefusal(err.response) : '';
      const detail = `${err.code || err.response?.status || 'ERR'}: ${err.message}${refusal ? ` [${refusal}]` : ''}`.slice(0, 320);
      lastScrapeNote.set(target.provider, detail);
      if (isBlockLikeError(err)) {
        const fails = (scrapeFailureState.get(target.provider)?.fails || 0) + 1;
        // probeEveryCycle targets (see PROVIDER_TARGETS) keep being tried every
        // cycle — no growing pauses — so they are picked up within one cycle of
        // the provider allowing us. Only an explicit Retry-After (below) delays them.
        const scheduledSkipUntil = !target.probeEveryCycle && fails >= FAILS_BEFORE_COOLDOWN
          ? Date.now() + Math.min(BASE_COOLDOWN_MS * 2 ** (fails - FAILS_BEFORE_COOLDOWN), MAX_COOLDOWN_MS)
          : 0;
        // If the refusal says when to come back (Retry-After), wait at least that
        // long — from the first refusal, not after three.
        const retryAfterMs = parseRetryAfterMs(err.response?.headers?.['retry-after']);
        const politeSkipUntil = retryAfterMs ? Date.now() + Math.min(retryAfterMs, MAX_COOLDOWN_MS) : 0;
        const skipUntil = Math.max(scheduledSkipUntil, politeSkipUntil);
        scrapeFailureState.set(target.provider, { fails, skipUntil, lastError: detail });
      }
    }

    // 1.5. Filter out anything that isn't actually a real outage announcement.
    // isAnnouncementIndicatingNoOutage() was only ever wired into the
    // separate Aresgas-specific gas loop — this main loop (which is what
    // every PROVIDER_TARGETS site, including every water/heating/gas source
    // added this session, actually goes through) never called it at all.
    // Strategies A-C only require ONE loose keyword ("авария", "ремонт",
    // "спиране"...) to appear ANYWHERE in a 25-30+ char paragraph, which
    // readily matches generic "About us" company-history blurbs, office-hours
    // banners, and disclaimer footers that happen to contain one of those
    // words without describing any actual event — confirmed live: several
    // newly-added small-town sites' homepages had no real news feed, so
    // Strategy C fell through to grabbing exactly this kind of boilerplate
    // as if it were a live outage.
    let keptItems = scrapedItems.filter((item) => !isAnnouncementIndicatingNoOutage(item.text));
    // Each район line is judged on its own text too — the whole-province blob passed the filter
    // above thanks to its other lines, while a single short line is what the integrity sweep sees.
    if (target.splitRegions) keptItems = splitRegionItems(keptItems, target).filter((item) => !isAnnouncementIndicatingNoOutage(item.text));

    // A firewall/WAF often answers a blocked server with a normal 200 and a
    // tiny challenge/"access denied" page instead of an error — no exception,
    // no items, nothing in the stats to tell it apart from a provider that
    // simply has no outages today. Confirmed live (2026-09-23): 18 providers
    // flipped between N items and 0 items with NO stored error, in step with
    // server restarts (each restart can land on a different outgoing address).
    // Only a page that looks like a block (very small, or a known challenge
    // title/text) is noted, so genuinely-empty providers stay quiet.
    // What kind of page it is (parked domain / their own server crashing /
    // bot-protection challenge / nearly empty) is worked out from the page's
    // visible text — see utils/pageDiagnosis.js. A big normal page with no
    // announcements (e.g. reCAPTCHA merely loaded by its contact form) is no
    // longer reported as blocked.
    if (keptItems.length === 0 && fetchInfo && !lastScrapeNote.has(target.provider)) {
      const diagnosis = diagnoseEmptyPage(fetchInfo);
      if (diagnosis) {
        lastScrapeNote.set(target.provider, diagnosis.note);
      } else {
        // A normal-looking page with no announcements. Usually that just means
        // "nothing today", but it is also what a provider whose hosting quietly
        // serves us something else looks like — so record how the page starts.
        // Prefixed "инфо:" so the health panel does not colour it as a problem.
        lastScrapeNote.set(target.provider, `инфо: няма съобщения на страницата (${fetchInfo.bytes} B) — започва с: "${pageSnippet(fetchInfo.html)}"`);
      }
    }
    return keptItems;
}

/**
 * Rows already saved under the wrong provider/utility (see runScraperJob: the target decides both) are moved to the
 * right one, so the next scrape finds them instead of inserting a twin. One query; hosts shared by targets of
 * different providers are skipped.
 */
export async function repairMislabelledTargetRows() {
  const byHost = new Map();
  for (const t of PROVIDER_TARGETS) {
    let origin = '';
    try { origin = new URL(t.url).origin; } catch (e) { continue; }
    const cur = byHost.get(origin);
    if (!cur) byHost.set(origin, { provider: t.provider, utility: t.defaultUtility || null, ambiguous: false });
    else if (cur.provider !== t.provider || cur.utility !== (t.defaultUtility || null)) cur.ambiguous = true;
  }
  const entries = [...byHost.entries()].filter(([, v]) => !v.ambiguous && v.utility);
  if (entries.length === 0) return 0;
  const values = entries.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(', ');
  const params = entries.flatMap(([origin, v]) => [`target:${origin}`, v.provider, v.utility]);
  const res = await query(
    `UPDATE outages o SET provider = v.provider, utility_type = v.utility
     FROM (VALUES ${values}) AS v(prefix, provider, utility)
     WHERE o.source_announcement_key LIKE v.prefix || '%' AND o.status IN ('active', 'scheduled')
       AND (o.provider <> v.provider OR o.utility_type <> v.utility)`, params);
  const n = res && typeof res.rowCount === 'number' ? res.rowCount : 0;
  if (n > 0) console.log(`🔧 [SCRAPER] Moved ${n} row(s) to the provider/utility of the page they came from.`);
  return n;
}

export async function runScraperJob(dryRun = false, providerFilter = null) {
  console.log(`\n====================================================`);
  console.log(`🕷️ [SCRAPER JOB STARTED${dryRun ? ' — DRY RUN (admin preview, nothing will be written)' : ''}${providerFilter ? ` — single provider: ${providerFilter}` : ''}] ${new Date().toISOString()}`);
  console.log(`====================================================`);

  // Admin "preview before commit" audit flow: every genuinely NEW outage
  // (no existing matching row — see upsertOutage()'s dryRun branch)
  // discovered across ALL providers below gets collected here instead of
  // written, so an admin can review and approve the actual list before any
  // of it reaches the live map.
  const dryRunCandidates = dryRun ? [] : null;

  // Fresh throttle/batch budget for THIS cycle only.
  aiParseCallsThisCycle = 0;
  if (!dryRun && !providerFilter) await repairMislabelledTargetRows().catch((e) => console.warn('repairMislabelledTargetRows:', e.message));

  // Per-provider "restart" from the admin health panel — matches against the
  // exact provider name each dedicated scraper reports to scraper_run_stats
  // (see the logAndRecordScraperStats/recordScraperRun calls in each one),
  // same names the health panel already displays. null/omitted runs
  // everything, unchanged from before this existed.
  const matchesFilter = (name) => !providerFilter || name.toLowerCase() === providerFilter.toLowerCase();

  // Run high-precision live power, water, gas & heating feeds across Bulgaria
  if (matchesFilter('Енерго-Про (ЕРП Север)')) await scrapeErpSeverLivePower(dryRun, dryRunCandidates);
  if (matchesFilter('EVN България')) await scrapeElYugLivePower(dryRun, dryRunCandidates);
  if (matchesFilter('Електрохолд')) await scrapeElektroholdLivePower(dryRun, dryRunCandidates);
  if (matchesFilter('Газови дружества (общо)')) await scrapeBulgarianGasUtilitiesLive(dryRun, dryRunCandidates);
  if (matchesFilter('Топлофикация София')) await scrapeSofiaHeatingToplo(dryRun, dryRunCandidates);
  if (matchesFilter('Софийска вода')) await scrapeSofiaWaterGis(dryRun, dryRunCandidates);
  if (matchesFilter('ВиК Стара Загора')) await scrapeStaraZagoraWaterLive(dryRun, dryRunCandidates);

  const results = [];
  const targets = providerFilter ? PROVIDER_TARGETS.filter((t) => t.provider.toLowerCase() === providerFilter.toLowerCase()) : PROVIDER_TARGETS;

  let providerFetchCount = 0;
  for (const target of targets) {
    // 1.5s throttle between outbound requests to external provider sites —
    // skipped before the very first one (nothing to space out from yet).
    providerFetchCount++;
    if (providerFetchCount > 1) await sleep(THROTTLE_DELAY_MS);

    const scrapedItems = await scrapeProviderTargetItems(target, { force: !!providerFilter });
    let parsedCount = 0;
    let savedCount = 0;

    // Process scraped items through AI Parser & Upsert Engine. Raised from a
    // default cap of 3 — confirmed live this was silently discarding real,
    // currently-active outages on ordinary days: ВиК Йовковци alone had 12
    // separate active announcements on its page, only the first 3 of which
    // ever got saved, every single scrape cycle, for as long as this cap
    // existed. A provider can still opt into an even higher itemLimit for
    // unusually wide territory (e.g. Електрохолд's single page spanning 10
    // provinces).
    for (const item of scrapedItems.slice(0, target.itemLimit || 20)) {
      try {
        console.log(`🤖 AI Parsing text for ${target.provider} (${target.city}): "${item.text.substring(0, 65)}..."`);
        const parsedOutage = await throttledAiParse(item.text, target.provider, target.city, item.sourceUrl);
        // The page belongs to this provider whatever its text mentions: a ВиК Сливен notice "…поради ремонт от
        // Електроразпределение Юг" was filed as an EVN ELECTRICITY outage, Веолия Варна's heating maintenance as
        // water. Provider and utility come from the target.
        const structuredOutage = { ...parsedOutage, provider: target.provider, utility_type: target.defaultUtility || parsedOutage.utility_type };
        parsedCount++;
        // item.sourceUrl is each article's own distinct permalink whenever
        // the site provides one (Strategy A only falls back to the generic
        // target.url when a real link/id is missing) — same
        // source_announcement_key mechanism as ЕРП Север/EVN/Топлофикация
        // София, applied generically here. Confirmed live it was needed:
        // without it, re-running the scraper for ВиК Йовковци (whose AI-
        // parsed date for the same announcement isn't perfectly consistent
        // call to call) created 4 separate rows for the exact same real
        // notice instead of recognizing and updating the one already saved.
        const announcementKey = item.sourceUrl && item.sourceUrl !== target.url ? `target:${item.sourceUrl}` : null;
        const savedOutage = await upsertOrCollect({
          ...structuredOutage,
          source_announcement_key: announcementKey,
          // target.region (see ВиК София област's own entry above for why)
          // takes priority over target.city — falling back to target.city
          // stays correct for every other target here, where the provider's
          // own default city IS also its real province name. regionUnknown
          // (see Ситигаз България's own entry for why) opts a genuinely
          // multi-province target OUT of the target.city fallback entirely,
          // leaving region empty rather than confidently wrong.
          region: structuredOutage.region || target.region || (target.regionUnknown ? '' : target.city)
        }, dryRun, dryRunCandidates);
        results.push(savedOutage);
        savedCount++;
      } catch (err) {
        console.error(`❌ Error parsing/saving outage for ${target.provider}:`, err.message);
      }
    }

    // Per-provider funnel counters — added after debugging ВиК Йовковци's
    // completeness end to end: with 50+ generic PROVIDER_TARGETS sharing one
    // loop, there was no per-provider visibility into where items were lost
    // (site selector miss vs AI parse failure vs upsert error) without
    // reading the full AI-parse log line by line. Logs even when 0 items
    // were found — silence would otherwise look identical to "not reached
    // yet this cycle".
    await logAndRecordScraperStats(target.provider, { found: scrapedItems.length, parsed: parsedCount, saved: savedCount, error: lastScrapeNote.get(target.provider) || null });
  }

  console.log(`✅ [SCRAPER JOB FINISHED${dryRun ? ' — DRY RUN' : ''}] Processed ${results.length} outage items across Bulgaria.`);

  // "Last scan" in the admin panel means the last FULL cycle actually wrote
  // data — a dry-run preview isn't that, and neither is a single-provider
  // restart (69 other providers weren't touched, so claiming "just scanned"
  // would be misleading about their own freshness).
  if (!dryRun && !providerFilter) {
    lastRunAt = new Date().toISOString();
    lastRunCount = results.length;
  }

  // Health check: compare every provider's run just recorded above against
  // its own recent history, and warn loudly if one that normally finds
  // outages just returned nothing — see scraperHealthService.js for why
  // this catches something urlHealthService.js's plain reachability check
  // cannot (a site returning HTTP 200 with restructured/empty content).
  await checkForScraperRegressions();

  if (dryRun) {
    return { dryRun: true, candidates: dryRunCandidates, totalChecked: results.length };
  }

  return results;
}
