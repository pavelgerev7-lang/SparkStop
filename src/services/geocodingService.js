import axios from 'axios';
import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BULGARIAN_SETTLEMENTS } from '../utils/bulgarianSettlements.js';
import { CITY_STREETS_DATABASE } from './autocompleteService.js';
import { NUMBERED_DISTRICT_NAMES } from '../utils/streetNormalizer.js';
import { query } from '../config/db.js';
import { ownValue } from '../utils/ownValue.js';
import { SETTLEMENT_ALIASES, SETTLEMENT_OVERRIDES, SUPERSEDED_SETTLEMENT_POINTS } from '../utils/settlementCorrections.js';
import { curatedStreetPoint, snapToMajorStreet } from '../utils/majorStreets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_FILE = path.resolve(__dirname, '../../data/geocoded_streets_cache.json');

// Persistent cache. Postgres when available — this local JSON file is
// wiped on every deploy (a fresh git checkout/container, exactly like the
// outages table was before IT moved to Postgres) — confirmed live: after a
// day of active development (many deploys), every single Nominatim result
// ever cached had been lost, forcing precise per-village/per-street
// coordinates to keep re-falling-back to a coarser point in the meantime.
// The in-memory Map stays the source of truth for every synchronous
// lookup in this file (nothing here becomes async) — only how it's loaded
// at startup and persisted on write changes.
let geocodeCache = new Map();

async function loadCache() {
  try {
    const dbResult = await query('SELECT cache_key, lat, lng FROM geocode_cache', []);
    if (dbResult && dbResult.rows) {
      for (const row of dbResult.rows) {
        geocodeCache.set(row.cache_key, { lat: row.lat, lng: row.lng });
      }
      console.log(`💾 [Geocode Cache] Loaded ${dbResult.rows.length} cached coordinates from PostgreSQL.`);
      return;
    }
  } catch (e) {
    console.warn('Could not load geocode_cache from PostgreSQL:', e.message);
  }
  // Fallback: local file (same behavior as before Postgres support existed)
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      geocodeCache = new Map(Object.entries(parsed));
    }
  } catch (e) {
    console.warn('Could not load geocoded_streets_cache.json:', e.message);
  }
}
await loadCache();

// One-time cleanup (see the result-class filter in geocodeStreetWithNominatim): villa-zone points cached
// before it existed may be a same-named business inside the town rather than the zone itself. They are
// simply looked up again; a marker row makes this run once.
{
  const PURGE_MARK = '__purge_villa_zone_points_v1__';
  if (!geocodeCache.has(PURGE_MARK)) {
    for (const key of [...geocodeCache.keys()]) if (/_(?:в\.\s*з\.|вилна зона)/.test(key)) geocodeCache.delete(key);
    geocodeCache.set(PURGE_MARK, { lat: 0, lng: 0 });
    query(`DELETE FROM geocode_cache WHERE cache_key LIKE '%\\_в.з.%' OR cache_key LIKE '%\\_вилна зона%'`, [])
      .then(() => query(`INSERT INTO geocode_cache (cache_key, lat, lng, updated_at) VALUES ($1, 0, 0, NOW()) ON CONFLICT (cache_key) DO NOTHING`, [PURGE_MARK]))
      .catch(() => {});
  }
}

function persistCacheEntryToFile() {
  try {
    const obj = Object.fromEntries(geocodeCache);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    // Ignore write errors
  }
}

// Persists ONE entry — a single UPSERT, not a full-cache rewrite (the local
// file's own persistCacheEntryToFile() below still rewrites the whole
// thing, kept only as a secondary/offline fallback, same as before).
// Fire-and-forget: never blocks the caller, same reasoning as every other
// background geocode write in this codebase.
function persistCache(cacheKey, value) {
  // Never store an area-average fallback as if it were this street's point
  // (that is how the poisoned rows got written) — see getCachedPoint().
  if (isFallbackCentroid(value)) return;
  query(
    `INSERT INTO geocode_cache (cache_key, lat, lng, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (cache_key) DO UPDATE SET lat = $2, lng = $3, updated_at = NOW()`,
    [cacheKey, value.lat, value.lng]
  ).catch(() => {});
  persistCacheEntryToFile();
}

// Nominatim's public instance policy caps requests at 1/sec with no
// parallel requests — but callers like getLiveMapOutages() geocode every
// affected street of every active outage via concurrent Promise.all, which
// on a cache miss (fresh deploy, or a scraped street name seen for the
// first time) could otherwise fire dozens of simultaneous requests and risk
// this server's IP getting rate-limited/blocked, breaking geocoding for
// everyone. Serialize every actual network call through here with an
// enforced gap; cache hits never touch this queue at all.
let lastNominatimRequestAt = 0;

const NOMINATIM_MIN_INTERVAL_MS = 1100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Requests are started one at a time, at least NOMINATIM_MIN_INTERVAL_MS apart, highest priority first. A person waiting
// in the "add address" form (verifyHouseNumberPlausible, priority 10) is served before the hundreds of background
// look-ups of streets and villages (priority 0): behind a FIFO queue of them, that check took 20 seconds.
const nominatimTasks = [];
let nominatimSeq = 0;
let nominatimWorkerRunning = false;
const interactiveScope = new AsyncLocalStorage();

async function runNominatimWorker() {
  if (nominatimWorkerRunning) return;
  nominatimWorkerRunning = true;
  while (nominatimTasks.length > 0) {
    const wait = Math.max(0, lastNominatimRequestAt + NOMINATIM_MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    const task = nominatimTasks.shift(); // picked AFTER the wait, so a person who arrived meanwhile goes first
    if (!task) break;
    lastNominatimRequestAt = Date.now();
    Promise.resolve().then(task.fn).then(task.resolve, task.reject); // in flight while the next one waits its gap
  }
  nominatimWorkerRunning = false;
}

function scheduleNominatimRequest(fn) {
  const priority = interactiveScope.getStore() ? 10 : 0;
  return new Promise((resolve, reject) => {
    nominatimTasks.push({ fn, priority, seq: nominatimSeq++, resolve, reject });
    nominatimTasks.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    runNominatimWorker();
  });
}

/**
 * Normalizes Bulgarian settlement/city names for lookup
 */
// Pure function of a small set of repeating inputs (settlement names from the
// registry and from outage records), called tens of thousands of times per
// live-map build — memoized. Bounded so a stream of odd scraped strings can't
// grow it forever.
const cleanNameMemo = new Map();
const CLEAN_NAME_MEMO_MAX = 20000;

export function cleanSettlementName(name = '') {
  const input = name || '';
  const hit = cleanNameMemo.get(input);
  if (hit !== undefined) return hit;
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^(?:гр\.\s*|с\.\s*|к\.к\.\s*|кв\.\s*|ж\.?к\.?\s*|село\s+|град\s+)/i, '')
    .replace(/\s*\(.*\)$/, '')
    // Bulletins abbreviate the leading title ("с. Проф. Иширково" is the registry's
    // "Професор Иширково"); registry names and looked-up names go through here alike.
    .replace(/^проф\.?\s+/, 'професор ')
    .replace(/^ген\.?\s+/, 'генерал ')
    .replace(/^св\.?\s+/, 'свети ')
    .trim();
  if (cleanNameMemo.size >= CLEAN_NAME_MEMO_MAX) cleanNameMemo.clear();
  cleanNameMemo.set(input, cleaned);
  return cleaned;
}

// Shared cache-key builder for every geocode cache in this file (the plain
// street/settlement cache below, and the per-house-number cache further
// down) — confirmed live: 2 real registry entries share a name across
// DIFFERENT, non-adjacent regions with near-identical coordinates (one a
// genuine data error just fixed — "с. Дойранци" existed in BOTH Шумен and
// Кърджали provinces, ~300km apart in reality, but the Шумен entry's own
// stored coordinate was a stray copy of Кърджали's). A cache key built from
// city+street alone can't tell those apart: whichever one gets resolved
// FIRST populates the shared key, and the other then silently reuses that
// same (wrong-region) cached point for the rest of the process's lifetime.
// Including region scopes the cache per-province, so same-named
// settlements in different regions always resolve and cache independently.
function buildGeoCacheKey(region, city, street, suffix = '') {
  return `${cleanSettlementName(region)}_${city}_${street}${suffix}`;
}

// CITY_STREETS_DATABASE is keyed by Title-Case city names ('София', 'Добрич',
// ...), but resolveExactCoordinates() below only ever has a lowercased,
// prefix-stripped cleanCity to look up with — a raw CITY_STREETS_DATABASE[cleanCity]
// is therefore always undefined, silently skipping the curated per-street
// coordinates for every city, every time. Indexing by the same
// cleanSettlementName() normalization used everywhere else on lookup makes
// the match actually fire regardless of the input's casing/prefix.
const CITY_STREETS_DB_BY_CLEAN_NAME = Object.entries(CITY_STREETS_DATABASE).reduce((acc, [key, streets]) => {
  acc[cleanSettlementName(key)] = streets;
  return acc;
}, {});

/**
 * Normalizes Bulgarian street names for OSM lookup
 */
export function cleanStreetForSearch(street = '') {
  const raw = (street || '').trim();
  if (!raw) return '';

  // Ordinal/date street names ("6-ти Септември", "25-ти Септември", "3-ти
  // Март") carry their date as part of the real name, not a house number —
  // normalize them first so the generic trailing-number strip below never
  // sees "Септември" followed by a number and chews off the whole name,
  // leaving an empty string that then wildcard-matches every curated DB
  // entry via "".includes("").
  const dateNormalized = raw
    .replace(/(?:^|[^а-яa-z0-9])(?:6-?ти|шести)\s+септември(?:$|[^а-яa-z0-9])/gi, ' 6 септември ')
    .replace(/(?:^|[^а-яa-z0-9])(?:25-?ти|двадесет\s+и\s+пети)\s+септември(?:$|[^а-яa-z0-9])/gi, ' 25 септември ')
    .replace(/(?:^|[^а-яa-z0-9])(?:3-?ти|трети)\s+март(?:$|[^а-яa-z0-9])/gi, ' 3 март ');

  // "местност"/"м-ст"/"м-т" ("locality") stripped too — confirmed live
  // against the real Nominatim API: querying "м-ст Акчелар, Варна,
  // България" returns ZERO results, while the identical query with just
  // "Акчелар, Варна, България" returns a real, precise point (a distinct
  // OSM neighbourhood node, not Варна's own city-center fallback). The
  // Bulgarian generic-locality word itself isn't part of OSM's indexed
  // name for these places, so leaving it in the query silently defeated
  // geocoding for every "м-ст X" entry — collapsing potentially many
  // genuinely different named localities onto one shared city-level pin,
  // not because of any pin-count limit, but because the search string
  // itself never matched anything.
  const cleaned = dateNormalized
    .replace(/^(?:ул\.\s*|бул\.\s*|кв\.\s*|ж\.?к\.?\s*|улица\s+|булевард\s+|квартал\s+|местност\s+|м-ст\s+|м-т\s+)/i, '')
    .replace(/\s*[-–—]\s*(?:ул\.|бул\.)\s*/i, ' ')
    .trim();

  // Numbered districts ("Младост 1", "Люлин 5") — the trailing digit is the
  // zone number, not a house number, and distinguishes otherwise-identical
  // district names; stripping it collapsed e.g. "Младост 4" onto "Младост
  // 1"'s coordinates.
  const districtMatch = cleaned.match(new RegExp(`^(${NUMBERED_DISTRICT_NAMES.join('|')})\\s*[-\\s]*(\\d+)?`, 'i'));
  if (districtMatch) {
    return districtMatch[2] ? `${districtMatch[1]} ${districtMatch[2]}` : districtMatch[1];
  }

  if (/^\d+\s+(?:септември|март)/i.test(cleaned)) {
    return cleaned.replace(/^(\d+\s+(?:септември|март))\s+\d.*$/i, '$1'); // "3 март 5" -> "3 март" (5 is the house number)
  }
  // A street named after a date/number keeps it: "8-ми март", "1-ви май", "9-ти септември" (the trailing-number
  // strip below turned these into an empty name, so they were never looked up at all).
  if (/^\d{1,2}-?(?:ти|ви|ри|ми|во|ма|ия)?\s+[А-Яа-я]/i.test(cleaned)) {
    return cleaned;
  }

  // Otherwise strip a genuine trailing house number ("Иван Вазов 12" -> "Иван Вазов")
  return cleaned.replace(/\s*\d+.*$/, '').trim();
}

/**
 * Finds the exact GPS coordinates for any Bulgarian settlement (city, town, or village)
 * from the official 5,265 settlements registry.
 */
// Average lat/lng of every settlement in the given municipality (preferred,
// more specific) or region — used as the last-resort fallback below when a
// region/municipality WAS specified but no settlement of that exact name
// could be found inside it. Never a substitute for a real settlement match;
// only ever reached when the caller already told us which area to stay in
// and we still can't find that specific place there.
//
// The registry is static, so every registry entry's normalized name /
// municipality / region is computed ONCE here (and looked up by name) instead
// of running cleanSettlementName's regexes over all 5,265 entries, 3x each, on
// every single lookup — that scan was ~2.8 s of the ~3.7 s of CPU it took to
// build one /api/outages/live-map response. Entry order is preserved, so every
// "first match" below picks exactly the entry the old linear .find() did.
const SETTLEMENT_INDEX = BULGARIAN_SETTLEMENTS.map((s) => ({
  s,
  name: cleanSettlementName(s.name),
  muni: cleanSettlementName(s.municipality),
  reg: cleanSettlementName(s.region)
}));
const SETTLEMENTS_BY_CLEAN_NAME = new Map();
for (const entry of SETTLEMENT_INDEX) {
  const bucket = SETTLEMENTS_BY_CLEAN_NAME.get(entry.name);
  if (bucket) bucket.push(entry); else SETTLEMENTS_BY_CLEAN_NAME.set(entry.name, [entry]);
}
const areaCentroidMemo = new Map();

// Every area-average ("centroid") point this file can hand out as a LAST-RESORT
// fallback (see getAreaCentroid). None of them is a real place — it is just the
// middle of a whole province/municipality — so a cached value that equals one
// of them is a "we didn't actually find it" marker, never a real geocode.
// Grows as new areas are computed; pre-filled below for every province and
// municipality in the registry.
const fallbackCentroidKeys = new Set();
const centroidKey = (lat, lng) => `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
function isFallbackCentroid(point) {
  return !!point && fallbackCentroidKeys.has(centroidKey(point.lat, point.lng));
}

function getAreaCentroid(cleanMuni, cleanReg) {
  const memoKey = `${cleanMuni}|${cleanReg}`;
  if (areaCentroidMemo.has(memoKey)) return areaCentroidMemo.get(memoKey);
  const matches = cleanMuni
    ? SETTLEMENT_INDEX.filter(e => e.muni === cleanMuni)
    : SETTLEMENT_INDEX.filter(e => e.reg === cleanReg || e.reg.includes(cleanReg));
  let centroid = null;
  if (matches.length > 0) {
    const avgLat = matches.reduce((sum, e) => sum + (e.s.lat || 0), 0) / matches.length;
    const avgLng = matches.reduce((sum, e) => sum + (e.s.lng || 0), 0) / matches.length;
    if (avgLat && avgLng) {
      centroid = { lat: avgLat, lng: avgLng };
      fallbackCentroidKeys.add(centroidKey(avgLat, avgLng));
    }
  }
  areaCentroidMemo.set(memoKey, centroid);
  return centroid;
}

for (const reg of new Set(SETTLEMENT_INDEX.map(e => e.reg))) getAreaCentroid('', reg);
for (const muni of new Set(SETTLEMENT_INDEX.map(e => e.muni))) getAreaCentroid(muni, '');
// A lookup that failed used to be cached as "the settlement centre" — for the villages whose registry position was wrong
// that cached point is the OLD, wrong centre, and next to the corrected centre it looks like a real street position
// (8 streets of Славяново sat there "exact"). Such points are treated like the area centroids: never trusted, never stored.
for (const [lat, lng] of SUPERSEDED_SETTLEMENT_POINTS) fallbackCentroidKeys.add(centroidKey(lat, lng));

// The ABSOLUTE last resort when literally nothing (curated street, village-as-settlement,
// even the outage's own city) could be resolved — not a real geocode of anything. Confirmed
// live: this used to be persisted like a real point whenever geocodeStreetWithNominatim's
// background job got a Nominatim "answer" that still resolved to nothing, poisoning 214
// distinct villages/towns across the country (Ботевград, Исперих, Кресна, Катунци, Троян,
// half of Софийска област...) onto Sofia's coordinates forever, exactly like the area-centroid
// bug above — same fix: never trusted from cache, never written back.
const ABSOLUTE_LAST_RESORT_POINT = { lat: 42.6977, lng: 23.3219 };
fallbackCentroidKeys.add(centroidKey(ABSOLUTE_LAST_RESORT_POINT.lat, ABSOLUTE_LAST_RESORT_POINT.lng));

// Cache read that refuses to return a poisoned entry. Earlier code stored the
// province-centroid fallback under the street's own key (and persisted it),
// so lookups kept returning "the middle of the province" for that street
// even after the resolver itself was fixed. Such an entry is dropped and
// recomputed instead; the next real geocode overwrites the stored row.
function getCachedPoint(cacheKey) {
  const hit = geocodeCache.get(cacheKey);
  if (hit === undefined) return undefined;
  if (isFallbackCentroid(hit)) {
    geocodeCache.delete(cacheKey);
    return undefined;
  }
  return hit;
}

// A provider's "region" is not always a province: ВиК Петрич / ВиК Берковица / ВиК Троян file
// their rows under the TOWN's name, ЕРП/Електрохолд under "София-област", while the registry
// files the province's settlements under "София-град" (and the capital under "София"). Such a
// label matched no registry region at all, so every village of those rows was "not found" and
// pinned on the area's centroid — or on nothing. Resolves it to the registry's own province name.
const REGION_ALIASES = { 'софия-област': 'софия-град', 'софийска област': 'софия-град', 'софия област': 'софия-град' };
const PROVINCE_NAMES = new Set(SETTLEMENT_INDEX.map((e) => e.reg));
const regionMemo = new Map();
export function normalizeRegionName(cleanReg) {
  if (!cleanReg) return cleanReg;
  if (regionMemo.has(cleanReg)) return regionMemo.get(cleanReg);
  let resolved = cleanReg;
  if (!PROVINCE_NAMES.has(cleanReg)) {
    if (ownValue(REGION_ALIASES, cleanReg)) resolved = ownValue(REGION_ALIASES, cleanReg);
    else {
      // An existing partial match ("софия" inside "софия-град") keeps the old lenient behaviour.
      const partial = [...PROVINCE_NAMES].some((p) => p.includes(cleanReg));
      if (!partial) {
        const town = (SETTLEMENTS_BY_CLEAN_NAME.get(cleanReg) || []).find((e) => e.s.type === 'гр.')
          || SETTLEMENT_INDEX.find((e) => e.muni === cleanReg);
        if (town) resolved = town.reg;
      }
    }
  }
  regionMemo.set(cleanReg, resolved);
  return resolved;
}

// Bulletins abbreviate the first word of a two-word village name: "с. Г. Кабда" (Горна Кабда),
// "с. М.Чинка" (Малка Чинка), "гр. Г. Тошево" (Генерал Тошево). The registry name that starts with
// that letter and ends with the rest — only when exactly one such name exists (in the province
// when known), so "Г." is never guessed between Горна/Голяма.
const abbreviationMemo = new Map();
export function expandAbbreviatedSettlementName(name, region = '') {
  const m = String(name || '').trim().replace(/^(?:(?:гр|с)\.\s*|(?:село|град)\s+)/i, '').match(/^([А-Яа-я])\.\s*([А-Яа-я][А-Яа-я\- ]*)$/);
  if (!m) return null;
  const letter = m[1].toLowerCase();
  const rest = cleanSettlementName(m[2]);
  if (rest.length < 3) return null;
  const cleanReg = normalizeRegionName(cleanSettlementName(region));
  const memoKey = `${letter}|${rest}|${cleanReg}`;
  if (abbreviationMemo.has(memoKey)) return abbreviationMemo.get(memoKey);
  const names = new Set();
  for (const e of SETTLEMENT_INDEX) {
    if (cleanReg && !(e.reg === cleanReg || e.reg.includes(cleanReg))) continue;
    if (e.name.length > rest.length + 1 && e.name.startsWith(letter) && e.name.endsWith(` ${rest}`)) names.add(e.s.name);
  }
  const result = names.size === 1 ? [...names][0] : null;
  abbreviationMemo.set(memoKey, result);
  return result;
}

export function getSettlementCoordinates(settlementName, municipality = '', region = '') {
  if (!settlementName) return null;
  const expanded = expandAbbreviatedSettlementName(settlementName, region);
  let cleanName = cleanSettlementName(expanded || settlementName);
  const cleanMuni = cleanSettlementName(municipality);
  const cleanReg = normalizeRegionName(cleanSettlementName(region));
  const hasAreaContext = !!(cleanMuni || cleanReg);

  // Verified corrections (see utils/settlementCorrections.js): the spelling a provider uses for a
  // village the registry names differently, and villages the registry lacks or misplaces.
  if (cleanReg) {
    cleanName = SETTLEMENT_ALIASES[`${cleanName}|${cleanReg}`] || cleanName;
    const fix = SETTLEMENT_OVERRIDES[`${cleanName}|${cleanReg}`];
    if (fix) return { ...fix };
  }

  if (hasAreaContext) {
    // 1. Exact match on name + municipality + region — the only genuinely
    // trustworthy case: this settlement, in that specific area.
    const sameName = SETTLEMENTS_BY_CLEAN_NAME.get(cleanName) || [];
    const strictEntry = sameName.find(e => {
      const muniMatch = !cleanMuni || e.muni === cleanMuni || e.muni.includes(cleanMuni);
      const regMatch = !cleanReg || e.reg === cleanReg || e.reg.includes(cleanReg);
      return muniMatch && regMatch;
    });
    const strictMatch = strictEntry && strictEntry.s;
    if (strictMatch && strictMatch.lat && strictMatch.lng) {
      return { lat: strictMatch.lat, lng: strictMatch.lng, name: strictMatch.name, region: strictMatch.region, municipality: strictMatch.municipality, type: strictMatch.type };
    }

    // 2. Same name, region only (municipality text from the source didn't
    // line up with the registry's own spelling, but the region still narrows
    // it down enough to trust a name match within it).
    if (cleanReg) {
      const regionEntry = sameName.find(e => e.reg === cleanReg || e.reg.includes(cleanReg));
      const regionMatch = regionEntry && regionEntry.s;
      if (regionMatch && regionMatch.lat && regionMatch.lng) {
        return { lat: regionMatch.lat, lng: regionMatch.lng, name: regionMatch.name, region: regionMatch.region, municipality: regionMatch.municipality, type: regionMatch.type };
      }
    }

    // 2.5. Bulletins often tack a descriptive phrase onto a village's own
    // name — confirmed live: ВиК Стара Загора's "с. Кирилово около
    // училището" ("...near the school") fell all the way through to
    // Стара Загора's OWN city-center point, even though "Кирилово" is in
    // the registry, correctly placed in the very municipality/region this
    // outage already gave us — because steps 1-2 above only match the
    // WHOLE phrase, not just the village's name inside it. Retried here by
    // dropping one trailing word at a time and re-running the exact SAME
    // strict-then-region checks as steps 1-2. A real multi-word village
    // name is never affected: its full name already matched above, so this
    // never even runs for it — it only fires once the untrimmed phrase has
    // already failed both checks.
    const nameWords = cleanName.split(' ').filter(Boolean);
    for (let n = nameWords.length - 1; n >= 1; n--) {
      const trimmedName = nameWords.slice(0, n).join(' ');
      if (trimmedName.length < 2) break;
      const trimmedSameName = SETTLEMENTS_BY_CLEAN_NAME.get(trimmedName) || [];
      if (!trimmedSameName.length) continue;
      const trimmedStrict = trimmedSameName.find(e => {
        const muniMatch = !cleanMuni || e.muni === cleanMuni || e.muni.includes(cleanMuni);
        const regMatch = !cleanReg || e.reg === cleanReg || e.reg.includes(cleanReg);
        return muniMatch && regMatch;
      });
      const trimmedStrictMatch = trimmedStrict && trimmedStrict.s;
      if (trimmedStrictMatch && trimmedStrictMatch.lat && trimmedStrictMatch.lng) {
        return { lat: trimmedStrictMatch.lat, lng: trimmedStrictMatch.lng, name: trimmedStrictMatch.name, region: trimmedStrictMatch.region, municipality: trimmedStrictMatch.municipality, type: trimmedStrictMatch.type };
      }
      if (cleanReg) {
        const trimmedRegionEntry = trimmedSameName.find(e => e.reg === cleanReg || e.reg.includes(cleanReg));
        const trimmedRegionMatch = trimmedRegionEntry && trimmedRegionEntry.s;
        if (trimmedRegionMatch && trimmedRegionMatch.lat && trimmedRegionMatch.lng) {
          return { lat: trimmedRegionMatch.lat, lng: trimmedRegionMatch.lng, name: trimmedRegionMatch.name, region: trimmedRegionMatch.region, municipality: trimmedRegionMatch.municipality, type: trimmedRegionMatch.type };
        }
      }
    }

    // 3. A region/municipality WAS given but no settlement of this name
    // exists inside it — deliberately never falls through to an
    // unconstrained name-only search from here on. Bulgaria has plenty of
    // duplicate settlement names across different provinces (confirmed real
    // bug this session: "с. Дойранци" exists in both Шумен and Кърджали —
    // an unconstrained name match could silently return the wrong one's
    // coordinates, hundreds of km off, for a real one dressed up as a
    // precise-looking pin). Returning that area's own centroid instead is a
    // visibly coarser fallback, clearly flagged via isRegionFallback so
    // callers can tell a "found the actual settlement" hit from "we only
    // know roughly which area this is in".
    // A village the registry lacks but OpenStreetMap has, looked up once inside the province (see
    // geocodeSettlementWithNominatim) — a real position instead of the province's average.
    if (cleanReg && !cleanMuni) {
      const learned = getCachedPoint(settlementCacheKey(cleanReg, cleanName));
      if (learned) return { lat: learned.lat, lng: learned.lng, name: String(settlementName).replace(/^(?:с\.|село|гр\.|град)\s*/i, '').trim(), region: region || null, municipality: null, type: 'с.' };
    }
    const centroid = getAreaCentroid(cleanMuni, cleanReg);
    // A provider's "region" is its own service area, which does not follow the province border:
    // EVN's Ямбол page lists Доброселец / Чукарово / Каменна река (община Тополовград, Хасково
    // province, ~40 km away), ЕРП Север's lists reach across the border too. Such a village was
    // reported as "not in the region" and pinned on the region's town. It is accepted from a
    // neighbouring province only when it is the ONE village of that name within 45 km of the area's
    // centre — two same-named villages there (Дойранци) stay ambiguous and fall through.
    // Never for a quarter / street entry: "кв. Марица" of Белово (Пазарджик) is a quarter of the town, but its
    // cleaned name "марица" matched the village Марица (Самоков, 42 km west, another province) and the pin
    // landed there marked "exact". The neighbouring-province rule exists for VILLAGES that a provider files
    // under the wrong service area, not for quarters/streets, which belong to the town the bulletin names.
    const namesQuarterOrStreet = /^\s*(?:кв\.|ж\.?\s?к\.?|к\.\s?к\.|квартал|ул\.|бул\.)/i.test(String(settlementName));
    if (centroid && cleanReg && !cleanMuni && sameName.length > 0 && !namesQuarterOrStreet) {
      const near = sameName.filter((e) => e.s.lat && e.s.lng
        && Math.hypot((e.s.lat - centroid.lat) * 111, (e.s.lng - centroid.lng) * 111 * Math.cos(centroid.lat * Math.PI / 180)) <= 45);
      if (near.length === 1) {
        const m = near[0].s;
        return { lat: m.lat, lng: m.lng, name: m.name, region: m.region, municipality: m.municipality, type: m.type };
      }
    }
    if (centroid) {
      return { lat: centroid.lat, lng: centroid.lng, name: settlementName, region: region || null, municipality: municipality || null, type: null, isRegionFallback: true };
    }
    return null;
  }

  // No region/municipality context given at all — nothing to violate, so an
  // unconstrained name lookup across the whole registry is the best we can
  // do (unchanged from before).
  const exactEntry = (SETTLEMENTS_BY_CLEAN_NAME.get(cleanName) || [])[0];
  const exactMatch = exactEntry && exactEntry.s;
  if (exactMatch && exactMatch.lat && exactMatch.lng) {
    return { lat: exactMatch.lat, lng: exactMatch.lng, name: exactMatch.name, region: exactMatch.region, municipality: exactMatch.municipality, type: exactMatch.type };
  }

  const partialEntry = SETTLEMENT_INDEX.find(e => e.name.startsWith(cleanName) || cleanName.startsWith(e.name));
  const partialMatch = partialEntry && partialEntry.s;
  if (partialMatch && partialMatch.lat && partialMatch.lng) {
    return { lat: partialMatch.lat, lng: partialMatch.lng, name: partialMatch.name, region: partialMatch.region, municipality: partialMatch.municipality, type: partialMatch.type };
  }

  return null;
}

/**
 * "с. Никюп"/"гр. Горна Оряховица"-style label for a settlement, with its
 * own real type prefix (village vs town/city) from the 5,265-settlement
 * registry — not assumed. Confirmed live: outage records for a village
 * were displayed under a hardcoded "гр. X" header (every settlement shown
 * as if it were a city) since the frontend had no way to tell a village
 * apart from a city by name alone. Falls back to "гр. <name>" only when
 * the settlement genuinely isn't found in the registry (keeps existing
 * behavior for anything this can't identify, rather than guessing wrong
 * in the other direction).
 */
export function formatSettlementLabel(settlementName, municipality = '', region = '', entries = []) {
  const match = getSettlementCoordinates(settlementName, municipality, region);
  const name = match?.name || settlementName || '';
  let type = match?.type === 'с.' ? 'с.' : (match?.type === 'гр.' ? 'гр.' : null);
  if (!type) {
    // Not in the registry (a hamlet / village it lacks): the bulletin's own entry tells the type —
    // "с. Армени" was labelled "гр. Армени" for lack of one. Without such an entry the old default stays.
    const wanted = cleanSettlementName(settlementName);
    const hint = (Array.isArray(entries) ? entries : []).map((e) => String(e || '').match(/^\s*(с\.|село|гр\.|град)\s+(.+?)\s*$/i))
      .find((m) => m && cleanSettlementName(m[2]) === wanted);
    if (hint) type = /^(с\.|село)$/i.test(hint[1]) ? 'с.' : 'гр.';
  }
  return `${type || 'гр.'} ${name}`.trim();
}

/**
 * Synchronous resolver (Cache -> Curated DB -> Settlement Center)
 */
// How far from its settlement's centre a real street of that settlement can plausibly
// be. A cached geocode further away than this is a same-named street in a
// neighbouring village/quarter (measured live: "ул. Васил Левски" of Бургас pinned
// 12 km away, "кв. Войново" of a Габрово village 213 km away) and is ignored — the
// pin then falls back to the settlement's own centre instead of "exactly" the wrong
// street.
const BIG_TOWNS = new Set(['пловдив', 'варна', 'бургас', 'русе', 'стара загора', 'плевен']);
export function maxStreetDistanceKm(cleanCity, settlement) {
  if (cleanCity === 'софия') return 15;
  if (BIG_TOWNS.has(cleanCity)) return 10;
  return settlement && settlement.type === 'гр.' ? 6.5 : 3.5;
}

function isPlausibleStreetPoint(point, cleanCity, municipality, region) {
  const centre = getSettlementCoordinates(cleanCity, municipality, region);
  if (!centre || centre.isRegionFallback || !centre.lat || !centre.lng) return true; // nothing to compare with
  return haversineDistanceKm(point.lat, point.lng, centre.lat, centre.lng) <= maxStreetDistanceKm(cleanCity, centre);
}

// A boulevard's pin must lie on the boulevard, and a few places are pinned by hand — see utils/majorStreets.js.
export function resolveExactCoordinates(city = 'София', street = '', municipality = '', region = '') {
  const cleanCity = cleanSettlementName(city);
  const curated = curatedStreetPoint(cleanCity, street);
  if (curated) return curated;
  return snapToMajorStreet(cleanCity, street, resolveExactCoordinatesRaw(city, street, municipality, region));
}

function resolveExactCoordinatesRaw(city = 'София', street = '', municipality = '', region = '') {
  const cleanCity = cleanSettlementName(city);
  const cleanStreet = cleanStreetForSearch(street);
  const cacheKey = buildGeoCacheKey(region, cleanCity, cleanStreet.toLowerCase());

  // An entry that NAMES a settlement ("с. Добротич", "гр. Добрич") is that settlement's own registry point, not a
  // street to search for. Checked before the street cache: earlier Nominatim runs stored a point under the same
  // key that can be a farm or a same-named place elsewhere — measured live: с. Добротич cached 23 km from the
  // village, с. Стожер 3 km, гр. Добрич 3 km — and, being cached, those kept winning over the audited registry.
  // Only with an area (region/municipality) given: without one a name-only lookup takes the first same-named
  // village of the country, and the cache is the better judge.
  if (cleanStreet && (region || municipality) && /^\s*(?:с\.|село|гр\.|град)\s+\S/i.test(String(street))) {
    const named = getSettlementCoordinates(street, municipality, region);
    if (named && named.lat && named.lng && !named.isRegionFallback) return { lat: named.lat, lng: named.lng };
  }

  const cachedPoint = getCachedPoint(cacheKey);
  if (cachedPoint && isPlausibleStreetPoint(cachedPoint, cleanCity, municipality, region)) return cachedPoint;

  // 1. Check curated city database
  if (cleanStreet && cleanCity) {
    const cityDb = ownValue(CITY_STREETS_DB_BY_CLEAN_NAME, cleanCity) || [];
    for (const item of cityDb) {
      const itemClean = cleanStreetForSearch(item.street).toLowerCase();
      if (itemClean === cleanStreet.toLowerCase() || itemClean.includes(cleanStreet.toLowerCase()) || cleanStreet.toLowerCase().includes(itemClean)) {
        const res = { lat: item.lat, lng: item.lng };
        geocodeCache.set(cacheKey, res);
        return res;
      }
    }
  }

  // 2. Try the street/village NAME ITSELF as a settlement first — many
  // "streets" in rural ЕРП Север/EVN bulletins are actually village names
  // ("с. Войнежа"), and the 5,265-settlement registry has that village's
  // OWN precise coordinates. Skipping straight to the outage's overall city
  // (what step 3 below does) meant EVERY village in a multi-village
  // bulletin collapsed onto the same point — confirmed live: one ЕРП Север
  // bulletin listing 23 distinct villages around Велико Търново produced 23
  // map pins that were all the exact same coordinate (Велико Търново's own
  // city center), because none of the villages' own names were ever looked
  // up — only the outage's city label was. A genuine street name (not a
  // settlement) safely finds nothing here and falls through to step 3
  // unchanged.
  //
  // isRegionFallback results are NOT accepted here. With a region/municipality
  // given, getSettlementCoordinates never returns null for an unknown name —
  // it returns that whole area's average point, flagged isRegionFallback. A
  // street such as "ул. Еленка" in Велинград is not a settlement, so it got
  // the middle of the whole Пазарджик province (~20 km from the town) as if it
  // were a real pin — measured live: 377 of 2,026 pins (19%), median 20 km off,
  // and it also made them look "exact" to the precision flag. A non-settlement
  // must fall through to step 3 (the outage's own town).
  if (cleanStreet) {
    const streetAsSettlement = getSettlementCoordinates(street, municipality, region);
    if (streetAsSettlement && streetAsSettlement.lat && streetAsSettlement.lng && !streetAsSettlement.isRegionFallback) {
      const res = { lat: streetAsSettlement.lat, lng: streetAsSettlement.lng };
      geocodeCache.set(cacheKey, res);
      return res;
    }
  }

  // 3. Resolve from 5,265 settlements registry using the outage's own city
  const settlement = getSettlementCoordinates(city, municipality, region);
  if (settlement && settlement.lat && settlement.lng) {
    const res = { lat: settlement.lat, lng: settlement.lng };
    return res;
  }

  return { ...ABSOLUTE_LAST_RESORT_POINT };
}

// Bounds how many brand-new (cache-miss) Nominatim lookups can be scheduled
// per window, regardless of caller — the scraper fires these in the
// background for every affected street of every outage on every 5-minute
// cycle, and a sudden burst of first-seen streets (a fresh deploy, or one
// unusually large bulletin like ERP Sever's 100+ locations) could otherwise
// queue up a long, slow-draining chain of pending network calls. A cache
// hit never counts against this — only genuinely new streets do — so this
// just paces the one-time backfill across a few more cycles instead of
// trying to do it all at once; nothing is ever skipped permanently, the
// next window picks up where this one left off.
// 90 per 5 minutes = one request every ~3.3 s on average (the queue below still enforces the
// public instance's 1 request/second limit). 40 took hours to re-try the ~360 streets that sat at
// their town centre after failed lookups.
const GEOCODE_BUDGET_PER_WINDOW = 90;
const GEOCODE_WINDOW_MS = 5 * 60 * 1000;
const retriedKeys = new Set(); // cache keys already re-tried in this process (see geocodeStreetWithNominatim)
let geocodeBudgetUsed = 0;
let geocodeWindowStartedAt = Date.now();

/**
 * Async geocode using OpenStreetMap Nominatim with persistent cache
 * Accurately finds the exact geographic line/point of the street in Bulgaria.
 */
export async function geocodeStreetWithNominatim(city = 'София', street = '', municipality = '', region = '') {
  const cleanCity = cleanSettlementName(city);
  const cleanStreet = cleanStreetForSearch(street);
  const cacheKey = buildGeoCacheKey(region, cleanCity, cleanStreet.toLowerCase());

  // A cached point is final — EXCEPT one that is only the settlement's own centre
  // (an earlier lookup that failed, often just a timeout or a 429 that was cached
  // as if Nominatim had answered "not found") or one implausibly far from it. Those
  // are tried again, once per process, so a street pinned at the town centre for
  // weeks gets its real position (measured live: 360 street entries sat at the
  // centre, and a sample of them is found by Nominatim today).
  const cachedPoint = getCachedPoint(cacheKey);
  if (cachedPoint) {
    const centre = getSettlementCoordinates(city, municipality, region);
    const isCentreOnly = !!centre && Math.abs(cachedPoint.lat - centre.lat) < 1e-6 && Math.abs(cachedPoint.lng - centre.lng) < 1e-6;
    const needsRetry = (isCentreOnly || !isPlausibleStreetPoint(cachedPoint, cleanCity, municipality, region)) && !retriedKeys.has(cacheKey);
    if (!needsRetry) return cachedPoint;
    retriedKeys.add(cacheKey);
  }

  if (!cleanStreet || cleanStreet.length < 2) {
    return resolveExactCoordinates(city, street, municipality, region);
  }

  if (Date.now() - geocodeWindowStartedAt > GEOCODE_WINDOW_MS) {
    geocodeWindowStartedAt = Date.now();
    geocodeBudgetUsed = 0;
  }
  // The background budget must not starve a person waiting in the address form (interactive scope).
  const interactive = !!interactiveScope.getStore();
  if (!interactive && geocodeBudgetUsed >= GEOCODE_BUDGET_PER_WINDOW) {
    return resolveExactCoordinates(city, street, municipality, region);
  }
  if (!interactive) geocodeBudgetUsed++;

  let answered = false;
  try {
    // Constrain the search to near the actual settlement — without this, a common
    // street name (e.g. "Дъб", "Централна") can match a same-named street in a
    // completely different town and silently return a location tens of km away.
    const settlementCenter = getSettlementCoordinates(city, municipality, region);
    let viewbox = '';
    if (settlementCenter) {
      const pad = 0.15; // ~15km — enough for a city's own streets/suburbs, not the next town over
      viewbox = `&viewbox=${settlementCenter.lng - pad},${settlementCenter.lat + pad},${settlementCenter.lng + pad},${settlementCenter.lat - pad}&bounded=1`;
    }
    // A villa zone / locality / quarter is a PLACE and a street is a ROAD: a shop or restaurant that merely
    // has a similar name inside the city is not it. ("в.з. Фиш фиш" — a villa zone near Оброчище, 30 km from
    // Добрич — was pinned "exact" on a business of that name in Добрич.) Entries without such a prefix
    // (an embassy, a school) keep accepting any result.
    const wantsPlace = /^(?:в\.\s*з\.|вилна\s+зона|м-ст|м-т|местност|кв\.|ж\.?к\.?|квартал)/i.test(String(street || '').trim());
    const wantsRoad = /^(?:ул\.|бул\.|улица|булевард)/i.test(String(street || '').trim());
    const classOk = (r) => {
      if (wantsPlace) return ['place', 'boundary', 'landuse', 'natural', 'highway'].includes(r.class);
      if (wantsRoad) return ['highway', 'place', 'boundary', 'landuse'].includes(r.class);
      return true;
    };
    // limit=5 + addressdetails=1, not limit=1 — confirmed live with a real
    // failure: "Варуша, Велико Търново" returned a same-named ROAD in
    // Килифарево (a different town ~9km away, but still inside the 15km
    // viewbox, so `bounded=1` alone didn't stop it) ranked ABOVE the
    // actual "кв. Варуша, Велико Търново" quarter — Nominatim's relevance
    // ranking has no idea which town we actually meant, so `bounded=1` only
    // filters candidates, it doesn't rank them by matching our target city.
    // Asking for several candidates and picking the first whose own
    // address.city/town/suburb matches the expected city is a real "city
    // context lock", vs trusting whatever ranked first in a 30km box.
    const base = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5';
    // A street is asked for by name AND town first (Nominatim's structured search): the free-text query
    // "Искър, Силистра" is answered with a river, a shop and a hotel of that name before the road (5 slots),
    // so 13% of the streets pinned at a town centre were in OpenStreetMap all along (measured 2026-09-26).
    const urls = [];
    if (wantsRoad) urls.push(`${base}&street=${encodeURIComponent(cleanStreet)}&city=${encodeURIComponent(cleanCity)}&country=${encodeURIComponent('България')}${viewbox}`);
    urls.push(`${base}&q=${encodeURIComponent(`${cleanStreet}, ${cleanCity}, България`)}${viewbox}`);

    for (let attempt = 0; attempt < urls.length; attempt++) {
      if (attempt > 0 && !interactive) {
        if (geocodeBudgetUsed >= GEOCODE_BUDGET_PER_WINDOW) break;
        geocodeBudgetUsed++;
      }
      const response = await scheduleNominatimRequest(() => axios.get(urls[attempt], {
        headers: {
          'User-Agent': 'SparkDrop-Bulgaria-Outage-Platform/2.0'
        },
        timeout: 4000
      }));

      answered = true;
      if (!response.data || response.data.length === 0) continue;
      const cleanExpectedCity = cleanCity;
      // The answer must actually be NAMED like what was asked for: "в.з. Фиш фиш, Добрич" was answered with
      // the administrative boundary of Добрич itself (fuzzy match), and its centre was pinned as the villa zone.
      const nameTokens = (s) => String(s || '').toLowerCase()
        .replace(/[„“”"'‘’«»,.\-–—()\d]/g, ' ')
        .replace(/(?:^|\s)(?:ул|улица|бул|булевард|кв|квартал|ж\s?к|жк|пл|площад|в\s?з|вилна|зона|м\s?ст|м\s?т|местност|св|ген|проф|д\s?р)(?=\s|$)/g, ' ')
        .split(/\s+/).filter((t) => t.length >= 3);
      const askedTokens = new Set(nameTokens(cleanStreet));
      const cityTokens = new Set(nameTokens(cleanCity));
      const nameOk = (r) => {
        if (askedTokens.size === 0) return true; // nothing distinctive to compare (a very short name)
        const got = nameTokens(r.name || String(r.display_name || '').split(',')[0]);
        if (got.length > 0 && got.every((t) => cityTokens.has(t))) return false; // the town itself
        return got.length === 0 || got.some((t) => askedTokens.has(t));
      };
      const cityMatch = response.data.find((r) => {
        if (!classOk(r) || !nameOk(r)) return false;
        const addr = r.address || {};
        // addr.municipality is deliberately NOT a candidate: it names the whole
        // municipality, so a street in ANY village of "Бургас" municipality matched
        // the town Бургас (a "ул. Васил Левски" 12 km away was pinned as exact).
        const candidates = [addr.city, addr.town, addr.village, addr.hamlet, addr.suburb]
          .filter(Boolean)
          .map((v) => cleanSettlementName(v));
        return candidates.some((c) => c === cleanExpectedCity || c.includes(cleanExpectedCity) || cleanExpectedCity.includes(c));
      });
      // Only ever trust a result whose OWN address fields actually name the
      // expected settlement. Falling back to response.data[0] when nothing
      // matched used to silently accept whatever ranked first inside the
      // 15km viewbox — confirmed real failure: a same-named street/road in a
      // NEIGHBORING town (still inside that box) can outrank the actual
      // street in the target town, since Nominatim's own relevance ranking
      // has no idea which settlement we actually meant. That produced
      // valid-looking coordinates for the wrong place, which is worse than
      // no coordinates — it looks precise on the map when it isn't. No
      // cityMatch now falls straight through to the next attempt / the
      // settlement-center fallback below instead of guessing.
      if (cityMatch) {
        const lat = parseFloat(cityMatch.lat);
        const lng = parseFloat(cityMatch.lon);
        if (!isNaN(lat) && !isNaN(lng) && isPlausibleStreetPoint({ lat, lng }, cleanCity, municipality, region)) {
          const result = { lat, lng };
          geocodeCache.set(cacheKey, result);
          persistCache(cacheKey, result);
          return result;
        }
      }
    }
  } catch (err) {
    // Graceful fallback
  }

  const fallback = resolveExactCoordinates(city, street, municipality, region);
  // Only an ANSWER from Nominatim ("nothing matches this town") is remembered. A
  // timeout / 429 / network error used to be cached as the town centre too, and
  // then stayed that way forever.
  if (answered) {
    geocodeCache.set(cacheKey, fallback);
    persistCache(cacheKey, fallback);
  }
  return fallback;
}

// ---- Villages the registry does not have --------------------------------------------------------------
// ЕРП Север / EVN / ВиК notices keep naming villages that are in neither the registry nor OUR corrections
// (Гарвани, Бамболово, Пряспа …); they were pinned on the province's average point. OpenStreetMap often has
// them, so each such name is looked up ONCE inside its province and remembered (in the same persistent
// cache as the street points). Reads stay synchronous: getSettlementCoordinates() only consults the cache.
const settlementCacheKey = (cleanReg, cleanName) => `settlement|${cleanReg}|${cleanName}`;
const settlementLookupTried = new Set();
const SETTLEMENT_ADDRESSTYPES = new Set(['village', 'hamlet', 'town', 'city', 'locality', 'suburb', 'neighbourhood', 'quarter', 'isolated_dwelling']);
const provinceBoxMemo = new Map();
function provinceBox(cleanReg) {
  if (provinceBoxMemo.has(cleanReg)) return provinceBoxMemo.get(cleanReg);
  let box = null;
  for (const e of SETTLEMENT_INDEX) {
    if (e.reg !== cleanReg || !e.s.lat || !e.s.lng) continue;
    box = box || { s: 90, n: 0, w: 180, e: 0 };
    box.s = Math.min(box.s, e.s.lat); box.n = Math.max(box.n, e.s.lat); box.w = Math.min(box.w, e.s.lng); box.e = Math.max(box.e, e.s.lng);
  }
  provinceBoxMemo.set(cleanReg, box);
  return box;
}

/** Remembers a village position (tests pass persist:false so nothing reaches the shared database). */
export function rememberSettlementPoint(name, region, lat, lng, { persist = true } = {}) {
  const cleanName = cleanSettlementName(String(name || '').replace(/^(?:с\.|село|гр\.|град)\s*/i, ''));
  const cleanReg = normalizeRegionName(cleanSettlementName(region));
  if (!cleanName || !cleanReg) return;
  const key = settlementCacheKey(cleanReg, cleanName);
  geocodeCache.set(key, { lat, lng });
  if (persist) persistCache(key, { lat, lng });
}

export async function geocodeSettlementWithNominatim(name, region) {
  const cleanName = cleanSettlementName(String(name || '').replace(/^(?:с\.|село|гр\.|град)\s*/i, ''));
  const cleanReg = normalizeRegionName(cleanSettlementName(region));
  if (!cleanName || cleanName.length < 3 || !cleanReg || !PROVINCE_NAMES.has(cleanReg)) return null;
  const key = settlementCacheKey(cleanReg, cleanName);
  const known = getCachedPoint(key);
  if (known) return known;
  if (settlementLookupTried.has(key)) return null;
  settlementLookupTried.add(key); // once per process; a village OpenStreetMap does not have is not asked for again and again
  const box = provinceBox(cleanReg);
  if (!box) return null;
  if (Date.now() - geocodeWindowStartedAt > GEOCODE_WINDOW_MS) { geocodeWindowStartedAt = Date.now(); geocodeBudgetUsed = 0; }
  if (geocodeBudgetUsed >= GEOCODE_BUDGET_PER_WINDOW) { settlementLookupTried.delete(key); return null; }
  geocodeBudgetUsed++;
  try {
    const pad = 0.12;
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=10&countrycodes=bg&q=${encodeURIComponent(`${cleanName}, ${region}, България`)}&viewbox=${box.w - pad},${box.n + pad},${box.e + pad},${box.s - pad}&bounded=1`;
    const response = await scheduleNominatimRequest(() => axios.get(url, { headers: { 'User-Agent': 'SparkDrop-Bulgaria-Outage-Platform/2.0' }, timeout: 6000 }));
    const sameName = (r) => cleanSettlementName(String(r.name || String(r.display_name || '').split(',')[0])) === cleanName;
    let hits = (response.data || []).filter((r) => {
      const at = r.addresstype || r.type;
      if (!SETTLEMENT_ADDRESSTYPES.has(at) && !SETTLEMENT_ADDRESSTYPES.has(r.type)) return false;
      return ['place', 'boundary'].includes(r.class) && sameName(r);
    });
    // A village OpenStreetMap only knows through its BUS STOP / railway stop of that name (Гарвани, Габрово): the
    // stop stands in the village.
    if (hits.length === 0) {
      hits = (response.data || []).filter((r) => sameName(r) && ((r.class === 'highway' && r.type === 'bus_stop') || (r.class === 'railway' && ['station', 'halt'].includes(r.type))));
    }
    if (hits.length === 0) return null;
    // One place, not two same-named villages (those stay ambiguous and keep the province fallback).
    const pts = hits.map((r) => ({ lat: parseFloat(r.lat), lng: parseFloat(r.lon) })).filter((p) => !isNaN(p.lat) && !isNaN(p.lng));
    if (pts.length === 0) return null;
    const spreadKm = Math.max(...pts.map((p) => haversineDistanceKm(p.lat, p.lng, pts[0].lat, pts[0].lng)));
    if (spreadKm > 4) return null;
    const point = pts[0];
    geocodeCache.set(key, point);
    persistCache(key, point);
    return point;
  } catch (err) {
    settlementLookupTried.delete(key); // a timeout / 429 is not an answer — try again on a later pass
    return null;
  }
}

/**
 * Synchronous cache-only lookup for a specific house number on a street —
 * mirrors resolveExactCoordinates()'s cache check, but for the per-number
 * keys geocodeStreetNumberPoint() below persists. Used by the live-map read
 * path (which must stay network-free, see getLiveMapOutages) to pick up a
 * real endpoint once the background warm-up below has resolved it, without
 * ever blocking on Nominatim itself.
 */
export function getCachedStreetNumberPoint(city, street, houseNumber, region = '') {
  const cleanCity = cleanSettlementName(city);
  const cleanStreet = cleanStreetForSearch(street);
  if (!cleanStreet || !houseNumber) return null;
  const cacheKey = buildGeoCacheKey(region, cleanCity, cleanStreet.toLowerCase(), `_no${houseNumber}`);
  return geocodeCache.get(cacheKey) || null;
}

function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Soft, non-blocking plausibility check for a specific house number on a
 * street — deliberately NOT a claim that the exact number is confirmed to
 * exist. OSM's house-number coverage in Bulgaria is too sparse for most
 * streets to treat "not found" as an error (that would produce constant
 * false warnings on genuinely valid addresses), so this only flags the case
 * it CAN be confident about: geocoding "street + number" together lands
 * somewhere implausibly far from the street itself — a strong signal of a
 * typo or a different street being matched, not just a data gap.
 */
export function verifyHouseNumberPlausible(...args) {
  return interactiveScope.run(true, () => verifyHouseNumberPlausibleImpl(...args));
}

async function verifyHouseNumberPlausibleImpl(city, street, houseNumber, municipality = '', region = '') {
  if (!houseNumber || !street) return { checked: false };

  const cleanStreet = cleanStreetForSearch(street);
  if (!cleanStreet || cleanStreet.length < 2) return { checked: false };

  const streetPoint = await geocodeStreetWithNominatim(city, street, municipality, region);
  if (!streetPoint) return { checked: false };

  try {
    const cleanCity = cleanSettlementName(city);
    const settlementCenter = getSettlementCoordinates(city, municipality, region);
    const query = `${cleanStreet} ${houseNumber}, ${cleanCity}, България`;
    let url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
    if (settlementCenter) {
      const pad = 0.15;
      const left = settlementCenter.lng - pad;
      const right = settlementCenter.lng + pad;
      const top = settlementCenter.lat + pad;
      const bottom = settlementCenter.lat - pad;
      url += `&viewbox=${left},${top},${right},${bottom}&bounded=1`;
    }

    const response = await scheduleNominatimRequest(() => axios.get(url, {
      headers: { 'User-Agent': 'SparkDrop-Bulgaria-Outage-Platform/2.0' },
      timeout: 4000
    }));

    if (!response.data || response.data.length === 0) {
      // Nothing found for the specific number — inconclusive, not an error.
      return { checked: true, plausible: true };
    }

    const lat = parseFloat(response.data[0].lat);
    const lng = parseFloat(response.data[0].lon);
    if (isNaN(lat) || isNaN(lng)) return { checked: true, plausible: true };

    const distanceKm = haversineDistanceKm(streetPoint.lat, streetPoint.lng, lat, lng);
    return { checked: true, plausible: distanceKm <= 3, distanceKm };
  } catch (err) {
    return { checked: false };
  }
}

/**
 * Real (Nominatim-backed, never fabricated) coordinate for ONE specific
 * house number on a street — the building block for rendering a genuinely
 * geocoded street-stretch line instead of a single point, when a bulletin
 * states a confirmed number range (e.g. "от №10 до №40"). Reuses the exact
 * same query/viewbox/plausibility pattern as verifyHouseNumberPlausible
 * above, but persists the resolved point under its own cache key so it's a
 * one-time network cost per distinct street+number, ever — same budget/rate
 * limit as every other Nominatim call in this file. Returns null (never a
 * guessed/interpolated point) whenever Nominatim has no data for that exact
 * number or the result lands implausibly far from the street itself; the
 * caller then simply keeps using the single street-level pin, same as
 * before this existed.
 */
export async function geocodeStreetNumberPoint(city, street, houseNumber, municipality = '', region = '') {
  const cleanCity = cleanSettlementName(city);
  const cleanStreet = cleanStreetForSearch(street);
  if (!cleanStreet || cleanStreet.length < 2 || !houseNumber) return null;

  const cacheKey = buildGeoCacheKey(region, cleanCity, cleanStreet.toLowerCase(), `_no${houseNumber}`);
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);

  if (Date.now() - geocodeWindowStartedAt > GEOCODE_WINDOW_MS) {
    geocodeWindowStartedAt = Date.now();
    geocodeBudgetUsed = 0;
  }
  if (geocodeBudgetUsed >= GEOCODE_BUDGET_PER_WINDOW) return null;
  geocodeBudgetUsed++;

  try {
    const settlementCenter = getSettlementCoordinates(city, municipality, region);
    const q = `${cleanStreet} ${houseNumber}, ${cleanCity}, България`;
    let url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`;
    if (settlementCenter) {
      const pad = 0.15;
      const left = settlementCenter.lng - pad;
      const right = settlementCenter.lng + pad;
      const top = settlementCenter.lat + pad;
      const bottom = settlementCenter.lat - pad;
      url += `&viewbox=${left},${top},${right},${bottom}&bounded=1`;
    }

    const response = await scheduleNominatimRequest(() => axios.get(url, {
      headers: { 'User-Agent': 'SparkDrop-Bulgaria-Outage-Platform/2.0' },
      timeout: 4000
    }));

    if (response.data && response.data.length > 0) {
      const lat = parseFloat(response.data[0].lat);
      const lng = parseFloat(response.data[0].lon);
      if (!isNaN(lat) && !isNaN(lng)) {
        const streetPoint = await geocodeStreetWithNominatim(city, street, municipality, region);
        if (streetPoint && haversineDistanceKm(streetPoint.lat, streetPoint.lng, lat, lng) > 3) {
          return null; // Implausible match (likely a different same-named street) — don't cache, don't use.
        }
        const result = { lat, lng };
        geocodeCache.set(cacheKey, result);
        persistCache(cacheKey, result);
        return result;
      }
    }
  } catch (err) {
    // No network result — caller falls back to the single street-level pin.
  }
  return null;
}
