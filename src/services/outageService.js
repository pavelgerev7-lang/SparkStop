import { query, inMemoryDB, persistLocalDB, getOutagesWriteVersion } from '../config/db.js';
import { isQuietHours } from '../utils/quietHours.js';
import { isAddressAffected, streetsOverlap, sameOutageMatch, normalizeStreetName, parseOutageNumberRange } from '../utils/streetNormalizer.js';
import { notifyAffectedUsersForOutage } from './notificationService.js';
import { resolveExactCoordinates, geocodeStreetWithNominatim, geocodeSettlementWithNominatim, geocodeStreetNumberPoint, getCachedStreetNumberPoint, getSettlementCoordinates, formatSettlementLabel, cleanSettlementName } from './geocodingService.js';
import { curatedStreetPoint } from '../utils/majorStreets.js';
import { resolveExactOfficialSourceUrl, isGenericSourceUrl, extractStreetsHeuristic, hasExplicitTimeInText, sanitizeAffectedStreet, getDailyScheduleInfo } from './aiParserService.js';
import { isAnnouncementIndicatingNoOutage, isOnlyPossibleDisruption } from '../utils/textCleaner.js';
import crypto from 'crypto';
import { ownValue } from '../utils/ownValue.js';

// The AI/heuristic parser is deliberately asked for standardized STREET
// NAMES ONLY in affected_streets (no house numbers), while a confirmed
// number/block range — when the bulletin actually states one — only ever
// lives in raw_location_text, extracted on demand by
// parseOutageNumberRange(). isAddressAffected() already USES that range to
// gate whether a specific saved address counts as affected, but nothing
// ever surfaced it back to a reader — someone looking at an outage card had
// no way to see the same number/block scope the matching logic itself was
// already applying. Formats it into a short human-readable suffix (or null
// when no confirmed range exists, e.g. "the whole street").
// Background (fire-and-forget) warm-up for a real, Nominatim-geocoded
// start/end point pair — only attempted when the bulletin names exactly ONE
// affected street AND parseOutageNumberRange found exactly one confident
// number range in the text (see that function's own comment on why it
// backs off rather than guess which street a range belongs to when there's
// more than one candidate). Never fabricates a line: each endpoint is a
// real geocode lookup that simply doesn't get used (getLiveMapOutages keeps
// showing the single street-level pin) if either one fails or lands
// implausibly far from the street.
function warmStreetRangeGeocode(city, streets, region, rawLocationText) {
  if (!Array.isArray(streets) || streets.length !== 1) return;
  const range = parseOutageNumberRange(rawLocationText);
  if (!range || range.type !== 'range' || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min === range.max) return;
  geocodeStreetNumberPoint(city, streets[0], range.min, '', region).catch(() => {});
  geocodeStreetNumberPoint(city, streets[0], range.max, '', region).catch(() => {});
}

function formatNumberScopeText(rawLocationText) {
  const scope = parseOutageNumberRange(rawLocationText);
  if (scope) {
    if (scope.type === 'blocks') {
      return `бл. ${scope.blocks.join(', ')}`;
    }
    const min = Math.min(scope.min, scope.max);
    const max = Math.max(scope.min, scope.max);
    const parity = scope.isEvenOnly ? ' (четни)' : (scope.isOddOnly ? ' (нечетни)' : '');
    return `№${min}-${max}${parity}`;
  }

  // parseOutageNumberRange() only recognizes a "от X до Y" range or a
  // "бл./блок" list — deliberately conservative, since it also gates
  // whether a specific saved address counts as affected and a wrong guess
  // there could wrongly clear someone who IS affected. The single most
  // common real format in scraped bulletins is neither of those — a plain
  // list of individual house numbers ("№15, №17, №17-А, №19, №21, №23") —
  // which is exactly the case that was showing no number at all on the
  // outage card. This is DISPLAY-ONLY (never used by isAddressAffected() /
  // notification matching): a bulletin naming several different streets can
  // list numbers for more than one of them together with no reliable way to
  // tell which number belongs to which street from free text alone, so
  // trusting this for a strict per-user match/no-match decision would risk
  // false negatives the same way a single merged range would. Showing every
  // № this bulletin mentions is still strictly more informative than
  // showing nothing, without that risk.
  const numberTokens = [...(rawLocationText || '').matchAll(/№\s*(\d+[а-яА-Я]?(?:\s*[-–—]\s*\d+)?)/g)]
    .map((m) => m[1].replace(/\s+/g, ''));
  if (numberTokens.length > 0) {
    const unique = [...new Set(numberTokens)];
    const shown = unique.slice(0, 10);
    const suffix = unique.length > shown.length ? '...' : '';
    return `№${shown.join(', №')}${suffix}`;
  }

  return null;
}

/**
 * Local cache check before spending an AI parse call: a provider's own
 * bulletin very commonly stays listed on their site UNCHANGED across many
 * consecutive 5-minute scrape cycles until it naturally expires — every one
 * of those re-scrapes used to send the exact same text to Gemini again, for
 * zero new information, which is almost certainly the real driver behind
 * exhausting the free daily quota this session. If the EXACT same raw text
 * for this provider+city already has a live (active/scheduled) row, its
 * already-parsed fields are reused directly — no AI/network call at all.
 * Only the status is recomputed here (cheap, local, no AI needed): the
 * transition from active/scheduled to resolved once expected_end_time
 * passes has always depended on the text being RE-PARSED, so skipping the
 * parse must not also skip that recomputation.
 * Returns null on a cache miss (any actual change in the text) — the
 * caller then falls through to a real AI parse exactly as before.
 */
export async function findCachedParsedOutage(provider, city, rawText) {
  if (!provider || !city || !rawText) return null;
  const res = await query(
    `SELECT utility_type, provider, city, region, raw_location_text, affected_streets, source_url, start_time, expected_end_time
     FROM outages
     WHERE provider = $1 AND LOWER(city) = LOWER($2) AND raw_location_text = $3 AND status IN ('active', 'scheduled')
     ORDER BY updated_at DESC LIMIT 1`,
    [provider, city, rawText]
  );
  const row = res?.rows?.[0];
  if (!row) return null;

  const now = new Date();
  const startTime = new Date(row.start_time);
  const endTime = new Date(row.expected_end_time);
  let status = 'active';
  if (endTime.getTime() <= now.getTime()) status = 'resolved';
  else if (startTime.getTime() > now.getTime()) status = 'scheduled';

  return {
    utility_type: row.utility_type,
    provider: row.provider,
    city: row.city,
    region: row.region,
    raw_location_text: row.raw_location_text,
    affected_streets: row.affected_streets,
    source_url: row.source_url,
    start_time: row.start_time,
    expected_end_time: row.expected_end_time,
    status
  };
}

const SETTLEMENT_PREFIX_RE = /^(?:с\.|село|гр\.|град)\s*/i;

/**
 * The same street named twice in one bulletin ("с. Алеково, с. Алеково"; a Sofia heating notice that mentions
 * ул. Райко Алексиев in three of its blocks) is ONE marker, not several stacked on the same point. Measured on the live
 * map: 22 outages carried identical duplicate pins, inflating the marker counts. The key is street + point, so
 * two genuinely different places that share a street name are both kept.
 */
export function dedupeStreetPins(pins) {
  const seen = new Set();
  return (pins || []).filter((p) => {
    const key = `${String(p && p.street || '').trim().toLowerCase()}|${Number(p && p.lat).toFixed(5)}|${Number(p && p.lng).toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Merges a re-scraped announcement's streets into the stored list (see the
 * comment where it is used). Every label is cleaned first
 * (sanitizeAffectedStreet), so garbage stored by an older parser — "с.
 * Мусина.Извиняваме", "град Плевен Аварийно" — is repaired on the next scrape
 * instead of being carried forward forever. A settlement written bare in the
 * old row ("Просена") and typed in the new one ("с. Просена") is the same
 * place: the typed label replaces the bare one instead of both being kept.
 * ул./бул./кв. prefixes are never stripped for comparison — "ул. Христо Ботев"
 * and "бул. Христо Ботев" are different streets.
 */
export function mergeAffectedStreets(existing, incoming) {
  const merged = []; // [{ key, label, typed }]
  const byKey = new Map();
  for (const raw of [...(existing || []), ...(incoming || [])]) {
    const label = sanitizeAffectedStreet(raw);
    if (!label) continue;
    const typed = SETTLEMENT_PREFIX_RE.test(label);
    const key = label.toLowerCase().replace(SETTLEMENT_PREFIX_RE, '').trim();
    if (!key) continue;
    const seen = byKey.get(key);
    if (!seen) {
      const entry = { key, label, typed };
      byKey.set(key, entry);
      merged.push(entry);
    } else if (typed && !seen.typed && !/^(?:ул\.|бул\.|кв\.|ж\.?к\.|пл\.|м-ст|местност|квартал)/i.test(seen.label)) {
      // Bare "Просена" already stored, now seen as "с. Просена".
      seen.label = label;
      seen.typed = true;
    }
  }
  return merged.map((e) => e.label);
}

/**
 * Upsert logic: Updates expected_end_time / status if outage exists for (provider, city, affected_streets overlap),
 * or inserts new outage record and triggers Push Notifications.
 *
 * @param {Object} outageData - Structured Outage object
 * @returns {Promise<Object>} The inserted or updated outage
 */
export async function upsertOutage(outageData, opts = {}) {
  const { dryRun = false } = opts;
  const {
    utility_type,
    provider,
    city,
    region,
    raw_location_text,
    affected_streets,
    lat,
    lng,
    source_url,
    start_time,
    expected_end_time,
    status,
    source_announcement_key
  } = outageData;

  // The integrity sweep (runDataIntegritySweep) resolves every live row whose text fails
  // isAnnouncementIndicatingNoOutage(). A row created here that would fail it is therefore
  // doomed: it shows on the map (and fires a push) until the next sweep, then the next scrape
  // creates it again — an insert/resolve loop, confirmed live for EVN's "Електропроводът е
  // собственост на Лукойл и не захранва клиенти" (36 rows) and a ВиК Добрич район line (25).
  // One shared predicate at the door, whatever scraper the row came from, ends that.
  if (typeof raw_location_text === 'string' && raw_location_text.trim() && isAnnouncementIndicatingNoOutage(raw_location_text)) {
    return { ...outageData, id: null, skipped: 'not an outage announcement' };
  }

  const currentCity = city || 'София';
  // Many of Bulgaria's 5,265 settlements share their exact name with an
  // unrelated settlement in a different region (some hundreds of km apart —
  // e.g. two different villages named "Иваново" in Ruse vs. Smolyan
  // province). Every scraper call site now passes its own known region (the
  // provider's coverage area, e.g. "Русе") alongside whatever city the
  // parser extracted, so the settlements-registry lookup below can require a
  // region match instead of blindly taking the first same-named settlement
  // in the registry array.
  const currentRegion = region || '';
  const currentStreets = Array.isArray(affected_streets) ? affected_streets : [];
  const currentProvider = provider || 'Софийска вода';
  const currentUtility = utility_type || 'water';
  const resolvedSourceUrl = resolveExactOfficialSourceUrl(currentProvider, currentCity, source_url, currentUtility);

  // Resolve exact street coordinate FAST (synchronous, no network) so this
  // outage is inserted/updated and visible to users immediately, no matter
  // how backed-up the Nominatim queue is. Awaiting the real geocode here
  // used to serialize it into the scrape loop itself — with ~60 providers
  // and every one of their streets sharing one global 1-req/sec queue, that
  // could stall a single scrape cycle for many minutes, delaying every
  // outage behind it in the loop (worse: the very thing this was meant to
  // help). Real, precise geocoding still happens below — just detached from
  // this outage's own insert/update, so a slow or failed lookup can never
  // hold up showing the outage itself.
  const geo = resolveExactCoordinates(currentCity, currentStreets[0] || raw_location_text, '', currentRegion);
  const heatingAnchor = currentProvider === 'Топлофикация София' ? sofiaDistrictCentre(currentRegion) : null;
  const cityLat = heatingAnchor ? heatingAnchor.lat : ((lat && lat !== 42.6977) ? lat : geo.lat);
  const cityLng = heatingAnchor ? heatingAnchor.lng : ((lng && lng !== 23.3219) ? lng : geo.lng);

  // Warm the shared geocode cache for every affected street in the
  // background (fire-and-forget, not awaited). geocodeStreetWithNominatim()
  // persists each real result to the same cache resolveExactCoordinates()
  // checks first — so once this resolves, the very next map read's
  // per-street pins (getLiveMapOutages, which recomputes them fresh on
  // every request) automatically pick up the precise position, with zero
  // extra wiring and zero risk to this insert/update completing on time.
  warmStreetGeocodes(currentCity, currentStreets, currentRegion, currentProvider);
  warmStreetRangeGeocode(currentCity, currentStreets, currentRegion, raw_location_text);

  // 1. Search for an existing active/scheduled outage matching provider, city, and overlapping streets
  let existingOutage = null;

  // Nothing proactively flips a row's status to 'resolved' the instant its
  // expected_end_time passes — that only happens the next time this SAME
  // announcement gets re-parsed. Without also checking expected_end_time
  // here, an already-ended outage still tagged 'active'/'scheduled' would
  // match a genuinely NEW, unrelated announcement arriving later for the
  // same street and get silently merged into it (the UPDATE path below,
  // which never calls notifyAffectedUsersForOutage — only a fresh INSERT
  // does) — meaning a real new outage could produce zero notification at
  // all instead of just a late one.
  // Columns trimmed to only what's actually read from existingOutage below
  // (utility_type/provider/city are already pinned by the WHERE clause, and
  // raw_location_text is only ever consulted as a last-resort geocoding
  // fallback when currentStreets is empty — which the AI/heuristic parser's
  // own fallback never actually lets happen). affected_streets is the one
  // that matters and stays untouched/complete, since it's what streetsOverlap()
  // does the real matching against — nothing about street accuracy changes.
  const searchSql = `
    SELECT id, region, affected_streets, source_url, start_time, expected_end_time, status, source_announcement_key, raw_location_text
    FROM outages
    WHERE LOWER(city) = LOWER($1)
      AND provider = $2
      AND status IN ('active', 'scheduled')
      AND expected_end_time > NOW()
  `;
  const dbSearch = await query(searchSql, [currentCity, currentProvider]);

  // streetsOverlap() does word-aware comparison via the same normalization
  // isAddressAffected() uses (strips ул./бул. prefixes, compares core
  // tokens) — raw substring .includes() on the ORIGINAL text used to treat
  // "бул. Христо Ботев" as matching "ул. Христо Ботев" purely because "бул."
  // literally ends in "ул.", and the same for any short street name that
  // happened to be a substring of an unrelated longer one. That silently
  // merged two different real outages under one row, losing whichever one
  // lost the race — or the reverse: failing to recognize a still-ongoing
  // outage on its next re-scrape because a reworded street list no longer
  // raw-substring-matched, forking a duplicate for the same real event.
  //
  // Street overlap ALONE isn't enough, either — confirmed live: ЕРП Север
  // routinely publishes a rolling ~2-week schedule of SEPARATE maintenance
  // windows for the same/overlapping villages (e.g. "с. Раданово" affected
  // on the 18th, AND again, separately, on the 24th). Matching on streets
  // only meant a scrape run processing both, in order, merged the second
  // straight into the first — overwriting its start_time/expected_end_time
  // and silently discarding the earlier one as a distinct visible outage.
  // Simulated live against the real feed: 29 genuinely separate, still-
  // relevant announcements for one region collapsed to just 16 rows this
  // way — exactly matching the user's report of real outages (a village
  // named "Леденик" among them) missing from the map despite being on the
  // provider's own site. Requiring the two start_times to be within the
  // same rough day (not just "streets overlap") keeps a genuine re-scrape
  // of the SAME still-scheduled window matching (its start_time doesn't
  // move between scrapes) while treating a different day's window as its
  // own separate outage instead of swallowing it.
  const DATE_PROXIMITY_MS = 20 * 60 * 60 * 1000;
  const datesClose = (a, b) => {
    if (!a || !b) return true;
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    if (Number.isNaN(ta) || Number.isNaN(tb)) return true;
    return Math.abs(ta - tb) <= DATE_PROXIMITY_MS;
  };

  // ЕРП Север stamps every individual announcement with its own unique
  // "Публикувано на DD.MM.YYYY HH:MM" publish timestamp (see
  // scrapeErpSeverLivePower() for how source_announcement_key is built from
  // it) — confirmed live, a far more reliable "is this really the same
  // announcement" signal than street overlap: several genuinely separate
  // announcements for overlapping villages had the EXACT same scheduled
  // start_time (so datesClose() alone couldn't tell them apart either), yet
  // each carried its own distinct publish timestamp. When both sides carry
  // this key, it's authoritative — match on it alone, skip the street/date
  // heuristics entirely, so a coincidental street/date overlap between two
  // truly separate announcements can never merge them. Providers that don't
  // supply a key (everything else) fall through to the existing heuristic.
  const matchesOutage = (row) => {
    if (source_announcement_key && row.source_announcement_key) {
      return row.source_announcement_key === source_announcement_key;
    }
    // Топлофикация София: a notice belongs to ONE district (its `region`). Matching on street/block overlap alone
    // merged an Изток notice into a Дианабад row (then every later Изток notice matched that row through its
    // "Изток" entry): 4 live rows carried the entries of 1-3 other districts.
    if (currentProvider === 'Топлофикация София' && String(row.region || '') !== String(currentRegion || '')) return false;
    return sameOutageMatch(row.affected_streets, currentStreets) && datesClose(row.start_time, start_time);
  };

  if (dbSearch && dbSearch.rows) {
    existingOutage = dbSearch.rows.find(matchesOutage);
  } else {
    // In-memory DB lookup
    existingOutage = inMemoryDB.outages.find(
      (o) =>
        o.city.toLowerCase() === currentCity.toLowerCase() &&
        o.provider === currentProvider &&
        ['active', 'scheduled'].includes(o.status) &&
        new Date(o.expected_end_time).getTime() > Date.now() &&
        matchesOutage(o)
    );
  }

  // 1-legacy. Same announcement, stored earlier under a coarser city label. The
  // parser used to file a village-only notice under the provider's default city
  // (ВиК Русе: "Стамболово" under city "Русе"); it now files it under the village
  // itself. The search above is scoped by city, so the re-scrape found no row,
  // inserted a second one for the same event, and left the old one behind until
  // it expired (which then showed as "2 събития на този адрес"). When the
  // announcement key is identical and the old row's own street list names this
  // very settlement, it is the same event: update it — the UPDATE below also
  // moves it to the correct city label.
  if (!existingOutage && source_announcement_key && dbSearch && dbSearch.rows) {
    const legacySearch = await query(`
      SELECT id, region, affected_streets, source_url, start_time, expected_end_time, status, source_announcement_key
      FROM outages
      WHERE provider = $1
        AND source_announcement_key = $2
        AND LOWER(city) <> LOWER($3)
        AND status IN ('active', 'scheduled')
        AND expected_end_time > NOW()
    `, [currentProvider, source_announcement_key, currentCity]);
    if (legacySearch && legacySearch.rows) {
      const wantedName = String(currentCity).toLowerCase().trim();
      // ЕРП Север / EVN / Електрохолд produce exactly ONE row per announcement key,
      // so the key alone identifies the old row (EVN notices were all filed under
      // their province name, and their street lists usually do not name the
      // settlement the parser now picks as city). Other providers can split one
      // announcement into several rows sharing a key, so they also need the old
      // row's own list to name this settlement.
      existingOutage = legacySearch.rows.find((row) => SYNC_CLOSED_PROVIDERS.has(currentProvider) || (row.affected_streets || []).some((s) =>
        sanitizeAffectedStreet(s).toLowerCase().replace(SETTLEMENT_PREFIX_RE, '').trim() === wantedName)) || null;
    }
  }

  // 1a. The source often marks an item "завършен" only AFTER its scheduled end
  // has passed (ВиК Русе: ул. Видин 48, scheduled to 15:00, marked done at
  // 15:00). The row is still tagged active/scheduled (nothing flips it by the
  // clock), but the search above ignores rows whose end time has passed — so the
  // completed announcement found no row to update, inserted a second, resolved
  // one, and left the original tagged "active" (a zombie until pruned). Look at
  // recently ended, still-open rows too and close THAT row instead.
  if (!existingOutage && status === 'resolved') {
    const endedSearch = await query(`
      SELECT id, region, affected_streets, source_url, start_time, expected_end_time, status, source_announcement_key
      FROM outages
      WHERE LOWER(city) = LOWER($1)
        AND provider = $2
        AND status IN ('active', 'scheduled')
        AND expected_end_time <= NOW()
        AND expected_end_time > NOW() - INTERVAL '48 hours'
    `, [currentCity, currentProvider]);
    if (endedSearch && endedSearch.rows) {
      existingOutage = endedSearch.rows.find(matchesOutage) || null;
    } else {
      existingOutage = inMemoryDB.outages.find(
        (o) =>
          o.city.toLowerCase() === currentCity.toLowerCase() &&
          o.provider === currentProvider &&
          ['active', 'scheduled'].includes(o.status) &&
          new Date(o.expected_end_time).getTime() <= Date.now() &&
          new Date(o.expected_end_time).getTime() > Date.now() - 48 * 60 * 60 * 1000 &&
          matchesOutage(o)
      ) || null;
    }
  }

  // 1b. A freshly-parsed announcement that computes to 'resolved' (the
  // source already marked it "завършен", or its own end time has passed)
  // has NO existing-row search above to catch it — that search deliberately
  // only looks at status IN ('active','scheduled'). The INSERT path's own
  // ON CONFLICT dedup (idx_outages_active_dedup) is equally scoped to
  // active/scheduled rows, so a provider that keeps re-listing an
  // already-finished item (confirmed live: vik-ruse.com's "failures" tab
  // does exactly this for hours after an outage is marked завършен) used to
  // INSERT a brand-new duplicate 'resolved' row on every single re-scrape,
  // forever, until pruneOldOutages() eventually caught up. Reproduced live:
  // one real ВиК Русе outage produced 16 duplicate resolved rows in under 3
  // hours this way. Scoped to a short 24h recency window (not "ever
  // resolved") so a genuinely new, unrelated outage recurring on the same
  // street weeks later still inserts its own fresh row instead of being
  // silently swallowed into old history.
  let existingResolved = null;
  if (!existingOutage && status === 'resolved') {
    const resolvedSearchSql = `
      SELECT id, affected_streets, start_time, expected_end_time, status, source_announcement_key
      FROM outages
      WHERE LOWER(city) = LOWER($1) AND provider = $2 AND status = 'resolved' AND updated_at > NOW() - INTERVAL '24 hours'
    `;
    const resolvedSearch = await query(resolvedSearchSql, [currentCity, currentProvider]);
    if (resolvedSearch && resolvedSearch.rows) {
      existingResolved = resolvedSearch.rows.find(matchesOutage);
    } else {
      existingResolved = inMemoryDB.outages.find(
        (o) =>
          o.city.toLowerCase() === currentCity.toLowerCase() &&
          o.provider === currentProvider &&
          o.status === 'resolved' &&
          new Date(o.updated_at).getTime() > Date.now() - 24 * 60 * 60 * 1000 &&
          matchesOutage(o)
      );
    }
  }

  // 1d. Same real event re-announced under a DIFFERENT announcement key.
  // matchesOutage() above treats two present keys as authoritative, which is
  // right for genuinely separate bulletins — but a source that simply
  // republishes the same announcement (ЕРП Север's own feed does this: same
  // text, second "Публикувано на" timestamp; EVN's table can list one twice)
  // then produced two rows for ONE event on every scrape. The integrity
  // sweep (runDataIntegritySweep) already defines "same event" as identical
  // provider+city+street list+start+end and resolves the older duplicate every
  // 20 minutes — after which the next scrape, finding no active row for the
  // resolved one's key, inserted it again: a permanent insert/resolve loop
  // (confirmed live: 19 re-creations of the same announcement in 6 hours,
  // ~1,200 throw-away rows, and a fresh "нова авария" push notification for
  // every one of them). Use the SAME definition here, so the scraper updates
  // the existing row instead of creating the duplicate the sweep would delete.
  // Street lists are compared as case-insensitive sets, since stored rows
  // accumulate merged/re-cased streets over time.
  let matchedBySignature = false;
  if (!existingOutage && !existingResolved && status !== 'resolved' && start_time && expected_end_time) {
    const norm = (list) => new Set((list || []).map((x) => (x || '').toLowerCase().trim()).filter(Boolean));
    const wanted = norm(currentStreets);
    const startMs = new Date(start_time).getTime();
    const endMs = new Date(expected_end_time).getTime();
    const pool = (dbSearch && dbSearch.rows)
      ? dbSearch.rows
      : inMemoryDB.outages.filter((o) => o.city.toLowerCase() === currentCity.toLowerCase() && o.provider === currentProvider && ['active', 'scheduled'].includes(o.status) && new Date(o.expected_end_time).getTime() > Date.now());
    // ЕРП Север re-publishes the same notice under a second "Публикувано на" stamp
    // (identical cleaned text, different key). Identical text + times is the same
    // event for these providers even when the STREET LIST differs — a row stored by
    // an older parser keeps its old list until the next update, and a list-only
    // comparison then failed to see the twin and inserted (or re-opened) a duplicate
    // that the integrity sweep resolved again, cycle after cycle.
    const sameText = SYNC_CLOSED_PROVIDERS.has(currentProvider) && !!raw_location_text;
    const twin = wanted.size > 0 && pool.find((row) => {
      if (new Date(row.start_time).getTime() !== startMs || new Date(row.expected_end_time).getTime() !== endMs) return false;
      if (sameText && row.raw_location_text === raw_location_text) return true;
      const have = norm(row.affected_streets);
      return have.size === wanted.size && [...wanted].every((x) => have.has(x));
    });
    if (twin) {
      existingOutage = twin;
      matchedBySignature = true;
    }
  }

  // 1e. An announcement closeVanishedOutages() resolved because the source stopped
  // listing it, and that the source lists AGAIN (a flaky page, an item restored):
  // re-open that very row. Inserting a fresh one would push a second "нова авария"
  // for something users were already told about.
  // Only rows THIS process closed (remembered in syncClosedRows) are re-opened: a
  // row the integrity sweep resolved as a duplicate must stay resolved, or the
  // scraper and the sweep would flip it back and forth every cycle.
  const syncClosed = source_announcement_key ? syncClosedRows.get(source_announcement_key) : null;
  if (!existingOutage && !existingResolved && status !== 'resolved' && syncClosed
      && Date.now() - syncClosed.at < 12 * 60 * 60 * 1000
      && SYNC_CLOSED_PROVIDERS.has(currentProvider) && dbSearch && dbSearch.rows) {
    const reopenSearch = await query(`
      SELECT id, region, affected_streets, source_url, start_time, expected_end_time, status, source_announcement_key
      FROM outages
      WHERE id = $1 AND status = 'resolved' AND expected_end_time > NOW()
    `, [syncClosed.id]);
    if (reopenSearch && reopenSearch.rows && reopenSearch.rows[0]) {
      existingOutage = reopenSearch.rows[0];
      syncClosedRows.delete(source_announcement_key);
      console.log(`♻️ [SYNC] Re-opening [${existingOutage.id}] in ${currentCity} — the source lists it again.`);
    }
  }

  // Dry-run mode (admin "preview before commit" audit flow): stops here,
  // right after the exact same lookup/matching logic a real run uses, so
  // the preview reflects a genuine decision — never runs the INSERT/UPDATE
  // SQL or a notification. Only 'new' entries (no existing row found) are
  // what the approval UI actually needs to show a human — an 'update'
  // just means an already-live outage's end time would be refreshed,
  // nothing a human needs to individually approve to appear on the map.
  if (dryRun) {
    if (existingOutage) {
      return {
        action: 'update',
        existing_id: existingOutage.id,
        provider: currentProvider,
        city: currentCity,
        affected_streets: currentStreets,
        start_time,
        expected_end_time,
        status
      };
    }
    if (existingResolved) {
      return {
        action: 'duplicate_resolved',
        existing_id: existingResolved.id,
        provider: currentProvider,
        city: currentCity,
        status
      };
    }
    return {
      action: 'new',
      utility_type: currentUtility,
      provider: currentProvider,
      city: currentCity,
      region: currentRegion,
      raw_location_text,
      affected_streets: currentStreets,
      source_url: resolvedSourceUrl,
      lat: cityLat,
      lng: cityLng,
      start_time,
      expected_end_time,
      status,
      source_announcement_key: source_announcement_key || null
    };
  }

  // 1c. Same real-world (already-resolved) announcement the source is just
  // still re-listing — touch it instead of inserting a duplicate. See the
  // existingResolved search above for why this exists.
  if (existingResolved) {
    await query('UPDATE outages SET updated_at = NOW() WHERE id = $1', [existingResolved.id]);
    console.log(`♻️ [DEDUP] Skipped duplicate resolved insert — already recorded [${existingResolved.id}] in ${currentCity}`);
    return { ...existingResolved, updated_at: new Date().toISOString() };
  }

  // 2. UPDATE existing outage if found
  if (existingOutage) {
    // Don't let a re-scrape that only matched the generic provider page (e.g. the
    // article link expired, or the page layout hiccuped that run) stomp on a
    // specific deep link a previous run already found for this same outage.
    const finalSourceUrl = (!isGenericSourceUrl(resolvedSourceUrl) || isGenericSourceUrl(existingOutage.source_url))
      ? resolvedSourceUrl
      : existingOutage.source_url;

    // A re-scrape can surface a street that wasn't in the previous version of
    // this same announcement (a bulletin gets edited/expanded, or a second
    // source mentions one more street) — merging instead of overwriting means
    // a user on that street can still match this outage via isAddressAffected()
    // on a later read, instead of the street silently vanishing from the record.
    // Deliberately case-INsensitive: confirmed live, ERP Sever/EVN's own
    // dedicated feeds don't consistently capitalize the same village/street
    // the same way on every scrape ("бул. 25 септември" one day, "бул. 25
    // Септември" the next) — a plain Set (exact string equality) kept both
    // as if they were different places, accumulating case-varied duplicates
    // of the same real street on every re-scrape instead of recognizing
    // them as the same one. Keeps whichever casing was already stored over
    // whatever the new scrape says, so this never flip-flops on every cycle.
    // ЕРП Север / EVN / Електрохолд parse every announcement deterministically from
    // its own text and keep exactly one row per announcement key, so on a key match
    // the fresh list REPLACES the stored one. Merging kept every entry an older
    // parser ever produced — truncated names ("ул. Яворов" next to "ул. П. Яворов"),
    // glued sentence words ("гр. Павел Баня БКТП-Маркони"), the generic placeholder —
    // for as long as the row lived. A twin match (two different keys for one event)
    // still merges, and so does every other provider.
    const keyMatched = !matchedBySignature && !!source_announcement_key && existingOutage.source_announcement_key === source_announcement_key;
    const mergedStreets = (REPLACE_ON_KEY_PROVIDERS.has(currentProvider) && keyMatched && currentStreets.length > 0)
      ? currentStreets
      : mergeAffectedStreets(existingOutage.affected_streets, currentStreets);
    const finalRegion = currentRegion || existingOutage.region || '';

    // Re-resolve coordinates on every update too, not just at insert time.
    // Before the region fix above, countless outages got geocoded to the
    // wrong same-named settlement at insert time and then sat there forever
    // — the update path only ever refreshed expected_end_time/status, so a
    // record already wrong could never self-correct on a later re-scrape
    // even once the scraper started supplying the right region. Recomputing
    // here means every outage heals itself the next time it's touched,
    // instead of only new ones being correct.
    const updateGeo = resolveExactCoordinates(currentCity, currentStreets[0] || raw_location_text || existingOutage.raw_location_text, '', finalRegion);
    const updateAnchor = currentProvider === 'Топлофикация София' ? sofiaDistrictCentre(finalRegion) : null;
    const updateLat = updateAnchor ? updateAnchor.lat : ((lat && lat !== 42.6977) ? lat : (updateGeo.lat || existingOutage.lat));
    const updateLng = updateAnchor ? updateAnchor.lng : ((lng && lng !== 23.3219) ? lng : (updateGeo.lng || existingOutage.lng));

    // Same background cache-warming as the INSERT path, for every merged street.
    warmStreetGeocodes(currentCity, currentStreets, finalRegion, currentProvider);
    warmStreetRangeGeocode(currentCity, currentStreets, finalRegion, raw_location_text || existingOutage.raw_location_text);

    // start_time used to be set once at INSERT and never touched again here —
    // so when a provider rescheduled an already-tracked outage (a very common
    // real occurrence: the bulletin's date/time changes between scrapes), our
    // stored start_time silently kept pointing at the FIRST-seen date forever
    // while expected_end_time and status kept refreshing from the latest
    // scrape. That produced exactly the "told me it'd happen but it didn't"
    // symptom (a user notified off the stale original date) and could also
    // make the map/traffic-light show a still-days-away outage as already
    // "started" (red) because isStarted only ever compared against that
    // frozen start_time. Refreshing it here the same way expected_end_time
    // already was makes an outage's schedule self-correct on its next
    // re-scrape instead of drifting out of sync with the real announcement.
    const updateSql = `
      UPDATE outages
      SET start_time = $1, expected_end_time = $2, status = $3, raw_location_text = COALESCE($4, raw_location_text), source_url = COALESCE($5, source_url), affected_streets = $6, region = COALESCE($7, region), lat = $8, lng = $9, source_announcement_key = COALESCE($10, source_announcement_key), city = COALESCE($12, city), updated_at = NOW()
      WHERE id = $11
      RETURNING *
    `;
    const dbUpdate = await query(updateSql, [
      start_time || existingOutage.start_time,
      expected_end_time || existingOutage.expected_end_time,
      status || existingOutage.status,
      matchedBySignature ? null : raw_location_text,
      finalSourceUrl || existingOutage.source_url,
      mergedStreets,
      finalRegion || null,
      updateLat,
      updateLng,
      matchedBySignature ? null : (source_announcement_key || null),
      existingOutage.id,
      currentCity
    ]);

    let updatedRecord;
    if (dbUpdate && dbUpdate.rows && dbUpdate.rows[0]) {
      updatedRecord = dbUpdate.rows[0];
    } else {
      existingOutage.start_time = start_time || existingOutage.start_time;
      existingOutage.expected_end_time = expected_end_time || existingOutage.expected_end_time;
      existingOutage.status = status || existingOutage.status;
      existingOutage.raw_location_text = raw_location_text || existingOutage.raw_location_text;
      existingOutage.source_url = finalSourceUrl || existingOutage.source_url;
      existingOutage.affected_streets = mergedStreets;
      existingOutage.city = currentCity;
      existingOutage.region = finalRegion || existingOutage.region;
      existingOutage.lat = updateLat;
      existingOutage.lng = updateLng;
      existingOutage.source_announcement_key = source_announcement_key || existingOutage.source_announcement_key;
      existingOutage.updated_at = new Date().toISOString();
      persistLocalDB();
      updatedRecord = existingOutage;
    }

    console.log(`🔄 Updated existing outage [${updatedRecord.id}] expected end time to ${updatedRecord.expected_end_time}`);
    return updatedRecord;
  }

  // A source that keeps listing a long-finished item ("Хотанца 18.09", "Кюстендил 19.09") used
  // to have it inserted as a fresh 'resolved' row the moment the earlier copy's 24h dedup
  // window ran out — and the hourly prune (rows ended > RETENTION_HOURS ago) deleted it again,
  // so the same ~50 history rows were re-created and deleted every hour, forever. Nothing reads
  // them (the map and address checks show active/scheduled only): skip the insert.
  if (status === 'resolved' && expected_end_time
      && new Date(expected_end_time).getTime() < Date.now() - RETENTION_HOURS * 60 * 60 * 1000) {
    return { ...outageData, id: null, skipped: 'ended before the retention window' };
  }

  // 3. INSERT new outage record
  // ON CONFLICT targets idx_outages_active_dedup (schema.sql) — a safety
  // net for exactly the failure mode that produced a 264-record pileup for
  // Павликени: a status-computation bug once made freshly-inserted rows
  // come back already 'resolved', which put them outside the dbSearch
  // WHERE-clause above (status IN ('active','scheduled')), so the same
  // announcement re-inserted on every ~10-minute scrape instead of ever
  // being found and updated. DO NOTHING never throws, so even if some
  // future bug reintroduces a similar gap in the application-level
  // matching above, this can only silently skip a redundant insert — never
  // crash the scraper loop or corrupt data.
  const insertSql = `
    INSERT INTO outages (utility_type, provider, city, region, raw_location_text, affected_streets, source_url, lat, lng, start_time, expected_end_time, status, source_announcement_key)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (provider, city, (md5(raw_location_text))) WHERE status IN ('active', 'scheduled') DO NOTHING
    RETURNING *
  `;
  const params = [
    utility_type || 'water',
    currentProvider,
    currentCity,
    currentRegion || null,
    raw_location_text || '',
    currentStreets,
    resolvedSourceUrl,
    cityLat,
    cityLng,
    start_time || new Date().toISOString(),
    expected_end_time || new Date(Date.now() + 4 * 3600000).toISOString(),
    status || 'active',
    source_announcement_key || null
  ];

  const dbInsert = await query(insertSql, params);

  let newOutageRecord;
  let wasConflictSkip = false;
  if (dbInsert && dbInsert.rows && dbInsert.rows[0]) {
    newOutageRecord = dbInsert.rows[0];
  } else if (dbInsert && dbInsert.rows && dbInsert.rows.length === 0) {
    // Real Postgres connection, but ON CONFLICT DO NOTHING skipped the
    // insert — an exact-duplicate active/scheduled row already exists
    // (the application-level match above should have found and updated it
    // already; this only fires if that logic somehow missed it). Fetch the
    // row that actually won the conflict instead of falling through to the
    // in-memory-DB branch below, which would otherwise fabricate a phantom
    // duplicate record and re-fire a push notification for something that
    // isn't new.
    wasConflictSkip = true;
    const existing = await query(
      `SELECT * FROM outages WHERE provider = $1 AND city = $2 AND md5(raw_location_text) = md5($3) AND status IN ('active', 'scheduled') ORDER BY updated_at DESC LIMIT 1`,
      [currentProvider, currentCity, raw_location_text || '']
    );
    newOutageRecord = existing?.rows?.[0] || null;
    if (!newOutageRecord) {
      console.warn(`⚠️ ON CONFLICT skip fired but no matching row found for ${currentProvider}/${currentCity} — skipping silently.`);
      return null;
    }
  } else {
    newOutageRecord = {
      id: `outage-${crypto.randomUUID()}`,
      utility_type: utility_type || 'water',
      provider: currentProvider,
      city: currentCity,
      region: currentRegion || '',
      raw_location_text: raw_location_text || '',
      affected_streets: currentStreets,
      source_url: resolvedSourceUrl,
      lat: cityLat,
      lng: cityLng,
      start_time: start_time || new Date().toISOString(),
      expected_end_time: expected_end_time || new Date(Date.now() + 4 * 3600000).toISOString(),
      status: status || 'active',
      source_announcement_key: source_announcement_key || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    inMemoryDB.outages.push(newOutageRecord);
    persistLocalDB();
  }

  if (wasConflictSkip) {
    console.log(`♻️ Skipped duplicate insert [${newOutageRecord.id}] in ${currentCity} — exact-match already active/scheduled.`);
    return newOutageRecord;
  }

  console.log(`✨ Inserted NEW outage record [${newOutageRecord.id}] in ${currentCity}`);

  // 4. Trigger Push Notifications matching user saved_addresses — but only
  // for something that's actually still relevant. This used to fire
  // unconditionally on every insert; only one of the several scraper call
  // sites (the gas/Aresgaz path) remembered to check status itself before
  // calling upsertOutage at all, so the other paths could push "⚠️ Засечена
  // авария на твоя адрес!" for something already resolved. Checking here,
  // once, centrally, means no future call site can forget it. Also checks
  // expected_end_time directly (not just the status string) since a
  // mis-dated historical/retrospective announcement can end up with
  // status: 'active' but an end time already in the past.
  const isStillRelevant = newOutageRecord.status !== 'resolved'
    && new Date(newOutageRecord.expected_end_time).getTime() > Date.now();
  // Never re-notify for an announcement whose identical twin (same provider +
  // city + text) was already recorded within the last 48h — users were
  // already told the first time, and a row that was resolved by the
  // integrity sweep and then re-created by the next scrape is the SAME real
  // outage, not a new one (that loop previously re-fired the push every 20
  // minutes).
  let alreadyNotifiedTwin = false;
  if (isStillRelevant && dbInsert && dbInsert.rows) {
    try {
      const twinCheck = await query(
        `SELECT 1 FROM outages WHERE provider = $1 AND city = $2 AND md5(raw_location_text) = md5($3) AND id <> $4 AND created_at > NOW() - INTERVAL '48 hours' LIMIT 1`,
        [currentProvider, currentCity, raw_location_text || '', newOutageRecord.id]
      );
      alreadyNotifiedTwin = !!(twinCheck && twinCheck.rows && twinCheck.rows.length);
    } catch (err) {
      console.warn('⚠️ Twin-notification check failed (notifying anyway):', err.message);
    }
  }
  if (alreadyNotifiedTwin) {
    console.log(`🔕 Skipped push for re-created outage [${newOutageRecord.id}] in ${currentCity} — an identical announcement was already recorded (and notified) in the last 48h.`);
  } else if (isStillRelevant) {
    try {
      await notifyAffectedUsersForOutage(newOutageRecord);
    } catch (err) {
      console.error('❌ Notification trigger error:', err.message);
    }
  }

  return newOutageRecord;
}

// "с. Опанец" / "гр. Габрово" / "село Брош" — an entry that names a whole settlement.
const SETTLEMENT_ENTRY_RE = /^(?:с\.|село|гр\.|град)\s+/i;

/** True when one of `streets` is a settlement entry naming exactly `city` ("с. Опанец" for "Опанец"). */
export function namesSettlement(streets, city) {
  const wanted = String(city || '').trim().toLowerCase();
  if (!wanted || !Array.isArray(streets)) return false;
  return streets.some((s) => SETTLEMENT_ENTRY_RE.test(String(s || '')) && String(s).replace(SETTLEMENT_ENTRY_RE, '').trim().toLowerCase() === wanted);
}

/**
 * For each entry of an outage's list, the settlement its pin must be looked up in.
 * A bulletin covers a town and villages ("гр. Габрово: ул. A, ул. B; с. Х: ул. C"):
 * a street belongs to the last settlement entry BEFORE it (a registry-confirmed one),
 * otherwise to the outage's own city. Looking every street up in the row's city put
 * the town's streets at a village's pin, and the village's at the town's.
 */
export function streetContextCities(city, streets, region = '') {
  let ctx = city;
  return (streets || []).map((entry) => {
    if (SETTLEMENT_ENTRY_RE.test(String(entry || ''))) {
      const name = String(entry).replace(SETTLEMENT_ENTRY_RE, '').trim();
      const found = getSettlementCoordinates(name, '', region);
      if (found && !found.isRegionFallback) ctx = found.name || name;
      return ctx;
    }
    return ctx;
  });
}

// Background Nominatim warm-up for the streets of one outage, each looked up in ITS
// settlement (see streetContextCities). A whole-settlement entry ("с. Опанец") needs no
// street lookup — the registry already has its point — and used to spend the shared
// 40-per-5-minutes Nominatim budget on searching a village as a street.
function warmStreetGeocodes(city, streets, region, provider = '') {
  // Zone-polygon rows are pinned at the zone centre — nothing to look up.
  if (ZONE_CENTRE_PROVIDERS.has(provider)) return;
  // Топлофикация София: each street of a group is looked up in София itself (see buildSofiaHeatingPins);
  // the district name in `region` must not reach the geocoder (it split the cache per district).
  if (provider === 'Топлофикация София') {
    if (!sofiaDistrictCentre(region)) return;
    for (const entry of streets) {
      if (sofiaDistrictCentre(entry)) continue;
      for (const st of extractStreetsHeuristic(entry)) {
        if (/^централна градска част$/i.test(st)) continue;
        geocodeStreetWithNominatim('София', st, '', '').catch(() => {});
      }
    }
    return;
  }
  const contexts = streetContextCities(city, streets, region);
  streets.forEach((st, idx) => {
    if (SETTLEMENT_ENTRY_RE.test(String(st || ''))) {
      const name = String(st).replace(SETTLEMENT_ENTRY_RE, '').trim();
      const found = getSettlementCoordinates(name, '', region);
      if (found && !found.isRegionFallback) return;
      // Not in the registry: ask OpenStreetMap once (inside the province) and remember the village.
      geocodeSettlementWithNominatim(name, region).catch(() => {});
      return;
    }
    geocodeStreetWithNominatim(contexts[idx], st, '', region).catch(() => {});
  });
}

// SQL twin of `city = $1 OR namesSettlement(affected_streets, $1)`. Written with
// [.] / [[:space:]] and a LOWER() first because Postgres (C.UTF-8) does not
// case-fold Cyrillic in regex flags, and a backslash in a template literal is
// easy to lose.
const CITY_OR_NAMED_SETTLEMENT_SQL = `(LOWER(city) = LOWER($1) OR EXISTS (
  SELECT 1 FROM unnest(affected_streets) AS s
  WHERE LOWER(s) ~ '^(с[.]|село|гр[.]|град)[[:space:]]'
    AND BTRIM(regexp_replace(LOWER(s), '^(с[.]|село|гр[.]|град)[[:space:]]+', '')) = LOWER($1)))`;

/**
 * GET /api/outages/check?street=...&city=...
 * Checks traffic light status (green / yellow / red) + countdown timer to expected_end_time
 */
export async function checkAddressOutageStatus(street, city = 'София') {
  if (!street) {
    throw new Error('Параметърът "street" е задължителен.');
  }

  // 1. Fetch active and scheduled outages for the city — including announcements
  // filed under ANOTHER city that name this settlement in their list. One bulletin
  // often covers several villages ("с. Богдан, с. Опанец, с. Драганово…") but is
  // stored under a single city (ЕРП Север: the first village; EVN: the province
  // name for everything), so a resident of any other named village never matched
  // it (confirmed live: 187 of 400 electricity rows named a settlement that was
  // not their own city). isAddressAffected() below still decides per address.
  let cityOutages = [];
  const dbResult = await query(
    `SELECT id, utility_type, provider, city, region, raw_location_text, affected_streets, lat, lng, start_time, expected_end_time, status
     FROM outages
     WHERE status IN ('active', 'scheduled') AND ${CITY_OR_NAMED_SETTLEMENT_SQL}
     ORDER BY expected_end_time ASC`,
    [city]
  );

  const now = new Date();
  if (dbResult && dbResult.rows) {
    cityOutages = dbResult.rows.filter((o) => ['active', 'scheduled'].includes(o.status) && new Date(o.expected_end_time) > now);
  } else {
    // Sorted to match the SQL branch's ORDER BY expected_end_time ASC — this
    // is the path that actually runs (no DATABASE_URL configured), and
    // without the sort, activeOutage/primaryOutage below picked whichever
    // outage happened to be scraped/inserted first rather than the one
    // that's actually most urgent (soonest to end).
    cityOutages = inMemoryDB.outages
      .filter((o) => (o.city.toLowerCase() === city.toLowerCase() || namesSettlement(o.affected_streets, city)) && ['active', 'scheduled'].includes(o.status) && new Date(o.expected_end_time) > now)
      .sort((a, b) => new Date(a.expected_end_time) - new Date(b.expected_end_time));
  }

  // 2. Filter outages matching the requested street with strict scope verification
  const matchingOutages = cityOutages.filter((outage) =>
    isAddressAffected(street, outage.affected_streets, outage.raw_location_text)
  );

  if (matchingOutages.length === 0) {
    // Check if the street has an outage, but this specific house/block number is safe outside the range
    const { normalizeStreetName, extractAddressNumbers } = await import('../utils/streetNormalizer.js');
    const userCore = normalizeStreetName(street);
    const sameStreetOutage = cityOutages.find((outage) => {
      return outage.affected_streets.some((s) => {
        const affCore = normalizeStreetName(s);
        return userCore && affCore && (userCore === affCore || userCore.includes(affCore) || affCore.includes(userCore));
      });
    });

    let description = 'Към момента няма регистрирани аварии или планирани ремонти на този адрес.';
    if (sameStreetOutage) {
      const { houseNumber, blockNumber } = extractAddressNumbers(street);
      if (houseNumber !== null || blockNumber !== null) {
        const numLabel = houseNumber !== null ? `№ ${houseNumber}` : `бл. ${blockNumber}`;
        description = `Захранването на ${numLabel} е нормално! На същата улица има авария, но твоят номер е извън засегнатия участък (${sameStreetOutage.raw_location_text || sameStreetOutage.affected_streets.join(', ')}).`;
      }
    }

    const geo = resolveExactCoordinates(city, street);
    return {
      status_code: 'green',
      status_label: 'Няма активни аварии',
      description,
      lat: geo.lat,
      lng: geo.lng,
      outages: [],
      countdown: null
    };
  }

  // Determine priority: active (red) takes precedence over scheduled (yellow). An
  // 'active' row that is only between its daily windows right now (supply is on)
  // must not outrank one that is genuinely cutting supply.
  const startedAlready = (o) => (o.start_time ? new Date(o.start_time).getTime() <= now.getTime() : true);
  const activeOutage = matchingOutages.find((o) => o.status === 'active' && !describeDailySchedule(o, now, startedAlready(o)).between_windows);
  const primaryOutage = activeOutage || matchingOutages[0];

  // Determine if outage has started
  const startTime = primaryOutage.start_time ? new Date(primaryOutage.start_time) : null;
  const isStarted = startTime ? startTime.getTime() <= now.getTime() : true;
  const primarySchedule = describeDailySchedule(primaryOutage, now, isStarted);
  const isUpcoming = (!isStarted && primaryOutage.status === 'scheduled') || primarySchedule.between_windows;

  // Some bulletins (ЕРП Север especially) only warn a disruption is POSSIBLE
  // during routine switching work ("са възможни смущения"), not that supply
  // will definitely be cut ("ще бъде прекъснато") — these used to show
  // identically as a firm "⚠️ Активна авария!" red alert, overstating
  // certainty for something that's really just a precaution.
  const isOnlyPossible = isOnlyPossibleDisruption(primaryOutage.raw_location_text || '');

  const isRed = !isOnlyPossible && !primarySchedule.between_windows && (primaryOutage.status === 'active' || (primaryOutage.status === 'scheduled' && isStarted));
  const statusCode = isOnlyPossible ? 'yellow' : (isRed ? 'red' : 'yellow');
  const statusLabel = isOnlyPossible
    ? 'Възможни кратки смущения (не е сигурна авария)'
    : (isRed ? 'Активна авария!' : (primarySchedule.between_windows && primarySchedule.next_window_text
      ? `Следващо прекъсване: ${primarySchedule.next_window_text}`
      : (isUpcoming ? 'Предстоящ планиран ремонт' : 'Планиран ремонт (в ход)')));

  // Calculate countdown timer if active / started
  let countdownData = null;
  if (!isUpcoming) {
    const endTime = new Date(primaryOutage.expected_end_time);
    const remainingMs = Math.max(0, endTime.getTime() - now.getTime());
    const totalSeconds = Math.floor(remainingMs / 1000);

    // A multi-day outage otherwise formatted as e.g. "⏳ 224:51:56" —
    // technically correct but hard to read at a glance. Break out a leading
    // days component once it's more than a day away.
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const formattedTimer = `⏳ ${days > 0 ? `${days}д ` : ''}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    countdownData = {
      total_seconds: totalSeconds,
      days,
      hours,
      minutes,
      seconds,
      formatted: formattedTimer,
      expected_end_time: primaryOutage.expected_end_time,
      is_upcoming: false
    };
  } else {
    countdownData = {
      total_seconds: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      formatted: null,
      start_time: primaryOutage.start_time,
      expected_end_time: primaryOutage.expected_end_time,
      is_upcoming: true
    };
  }

  // Ensure each outage has source_url populated
  const enrichedOutages = matchingOutages.map((o) => ({
    ...o,
    source_url: o.source_url || getDefaultProviderUrl(o.provider, o.city),
    // See the matching comment on getLiveMapOutages() above.
    time_is_estimated: !hasExplicitTimeInText(o.raw_location_text),
    city_label: formatSettlementLabel(o.city, '', o.region, o.affected_streets),
    ...describeDailySchedule(o, now, startedAlready(o))
  }));

  const primaryGeo = resolveExactCoordinates(primaryOutage.city, primaryOutage.affected_streets?.[0] || street, '', primaryOutage.region || '');
  const primaryEnriched = {
    ...primaryOutage,
    lat: (primaryOutage.lat && primaryOutage.lat !== 42.6977) ? primaryOutage.lat : primaryGeo.lat,
    lng: (primaryOutage.lng && primaryOutage.lng !== 23.3219) ? primaryOutage.lng : primaryGeo.lng,
    source_url: primaryOutage.source_url || getDefaultProviderUrl(primaryOutage.provider, primaryOutage.city),
    is_upcoming: isUpcoming,
    has_started: isStarted,
    number_scope: formatNumberScopeText(primaryOutage.raw_location_text),
    time_is_estimated: !hasExplicitTimeInText(primaryOutage.raw_location_text),
    // See the matching comment on getLiveMapOutages() above.
    city_label: formatSettlementLabel(primaryOutage.city, '', primaryOutage.region, primaryOutage.affected_streets),
    ...primarySchedule
  };

  return {
    status_code: statusCode,
    status_label: statusLabel,
    is_upcoming: isUpcoming,
    has_started: isStarted,
    street,
    city,
    lat: primaryEnriched.lat,
    lng: primaryEnriched.lng,
    source_url: primaryEnriched.source_url,
    primary_outage: primaryEnriched,
    outages: enrichedOutages,
    countdown: countdownData
  };
}

/**
 * Returns the official direct URL for any Bulgarian utility provider
 */
export function getDefaultProviderUrl(provider = '', city = '', specificUrl = '') {
  return resolveExactOfficialSourceUrl(provider, city, specificUrl);
}

// The frontend polls this endpoint every 30s per open tab (see index.html's
// setInterval) purely to catch up with the scraper — but the underlying data
// can't actually change more often than the scraper's own ~5-minute cycle.
// Without caching, every one of those polls, from every simultaneously open
// tab, hit Postgres directly and pulled back the FULL active/scheduled table
// (up to ~150 rows, some with hundreds of street names each) — confirmed
// live as the dominant driver behind blowing through Neon's free-tier 5GB/
// month egress quota in just days. A short server-side cache turns however
// many concurrent pollers there are into at most one real Postgres query per
// TTL window — nothing about which streets are affected is altered or
// truncated, this only avoids re-fetching identical data that hasn't changed.
//
// Shape of the cache: ONE snapshot of every active/scheduled outage, built
// once; the per-city / per-utility views are just filtered slices of it. It
// used to be one cache entry per (city, utility) pair, each built from scratch
// by its own SQL query + the full geocoding pass — so the first visitor to
// click each map filter (electricity / water / heating ...) after every 60 s
// expiry waited for a cold rebuild, measured live at 1.8 s (electricity) to
// 3.6 s (heating), 6.8 s for "all". The snapshot is also refreshed
// stale-while-revalidate: once it is older than the TTL the caller still gets
// it immediately and a single background rebuild starts (concurrent callers
// share it), so no request waits on a rebuild except the very first one after
// a restart (which server.js warms at startup).
const LIVE_MAP_CACHE_TTL_MS = 60 * 1000;
// Past this age a snapshot is too stale to hand out even while refreshing.
const LIVE_MAP_MAX_STALE_MS = 10 * 60 * 1000;
let liveMapSnapshot = null; // { data, computedAt }
let liveMapRefreshInFlight = null;

/**
 * Admin outages browser table (Section 4 of the admin panel) — paginated,
 * filterable by utility_type, free-text searchable across city/provider/
 * raw_location_text. Unlike getStatsHandler's utility breakdown (which
 * loads every row into JS to count), this filters and paginates entirely
 * in SQL — the table is meant for browsing the full history (94k+ rows and
 * growing), not just the small live-map subset.
 */
export async function getOutagesTablePage({ utility, search, status, limit = 25, offset = 0 } = {}) {
  const conditions = [];
  const args = [];
  if (utility && ['water', 'electricity', 'heating', 'gas'].includes(utility)) {
    args.push(utility);
    conditions.push(`utility_type = $${args.length}`);
  }
  if (status && ['active', 'scheduled', 'resolved'].includes(status)) {
    args.push(status);
    conditions.push(`status = $${args.length}`);
  }
  if (search && search.trim()) {
    args.push(`%${search.trim()}%`);
    conditions.push(`(city ILIKE $${args.length} OR provider ILIKE $${args.length} OR raw_location_text ILIKE $${args.length})`);
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(`SELECT COUNT(*)::int AS n FROM outages ${whereSql}`, args);
  if (!countResult) return { total: 0, rows: [] };

  const pageArgs = [...args, limit, offset];
  const rowsResult = await query(
    `SELECT id, utility_type, provider, city, raw_location_text, status, start_time, expected_end_time
     FROM outages ${whereSql}
     ORDER BY start_time DESC
     LIMIT $${pageArgs.length - 1} OFFSET $${pageArgs.length}`,
    pageArgs
  );

  return {
    total: countResult.rows?.[0]?.n || 0,
    rows: rowsResult?.rows || []
  };
}

/**
 * GET /api/outages/live-map
 * Returns list of all active/scheduled outages formatted for Dark Mode map rendering.
 * Optional city / utility filters are slices of the one shared snapshot (see
 * the cache comment above) — same rows, same order, same shape as before.
 */
export async function getLiveMapOutages(cityFilter, utilityFilter) {
  let snapshot = liveMapSnapshot;
  const age = snapshot ? Date.now() - snapshot.computedAt : Infinity;
  if (!snapshot || age > LIVE_MAP_MAX_STALE_MS) {
    snapshot = await refreshLiveMapSnapshot();
  } else if (age > LIVE_MAP_CACHE_TTL_MS) {
    // Serve the (slightly stale) snapshot now, rebuild in the background.
    refreshLiveMapSnapshot().catch((err) => console.error('⚠️ [LIVE MAP] Background refresh failed:', err.message));
  }

  if (!cityFilter && !utilityFilter) return snapshot.data;
  const wantedCity = cityFilter ? String(cityFilter).toLowerCase() : null;
  const wantedUtility = utilityFilter ? String(utilityFilter) : null;
  return snapshot.data.filter((o) =>
    (!wantedCity || String(o.city || '').toLowerCase() === wantedCity)
    && (!wantedUtility || o.utility_type === wantedUtility));
}

/**
 * Builds (or joins the already-running build of) the live-map snapshot.
 * Also called once at startup so the first visitor never pays for a cold build.
 */
export function refreshLiveMapSnapshot() {
  if (!liveMapRefreshInFlight) {
    liveMapRefreshInFlight = buildLiveMapOutages()
      .then((data) => {
        liveMapSnapshot = { data, computedAt: Date.now() };
        return liveMapSnapshot;
      })
      .finally(() => {
        liveMapRefreshInFlight = null;
      });
  }
  return liveMapRefreshInFlight;
}

// In the quiet hours (see utils/quietHours.js) nothing writes to the outages table, so an open tab's
// polling must not wake the database either. The table's rows are then read at most this often; the
// snapshot is still rebuilt every minute from these rows (in memory), so the time-dependent flags
// (started / between daily windows / ended) stay correct. Any write to the table drops the copy.
const LIVE_MAP_QUIET_ROWS_TTL_MS = 30 * 60 * 1000;
let liveMapRows = null; // { rows, fetchedAt, version }

export function canReuseLiveMapRows(cache, { quiet, now = Date.now(), version }) {
  return Boolean(quiet && cache && cache.version === version && now - cache.fetchedAt < LIVE_MAP_QUIET_ROWS_TTL_MS);
}

async function loadLiveMapRows() {
  const version = getOutagesWriteVersion();
  if (canReuseLiveMapRows(liveMapRows, { quiet: isQuietHours(), version })) return { rows: liveMapRows.rows };

  const dbResult = await query(`
    SELECT id, utility_type, provider, city, region, raw_location_text, affected_streets, lat, lng, source_url, start_time, expected_end_time, status
    FROM outages
    WHERE status IN ('active', 'scheduled')
    ORDER BY start_time DESC, id
  `, []);
  if (dbResult && dbResult.rows) liveMapRows = { rows: dbResult.rows, fetchedAt: Date.now(), version };
  return dbResult;
}

async function buildLiveMapOutages() {
  let outages = [];

  const dbResult = await loadLiveMapRows();

  const now = new Date();
  // Keep the map focused on what's actually imminent — already-active outages plus
  // anything starting within the next 7 days. Outages scheduled further out than that
  // just add clutter without being actionable yet; they'll surface on their own once
  // they fall inside this window on a later scrape.
  const mapHorizonMs = now.getTime() + 7 * 24 * 60 * 60 * 1000;
  const isWithinMapHorizon = (o) => new Date(o.start_time).getTime() <= mapHorizonMs;

  // Reverted (explicit admin request): a prior change hid a 'scheduled'
  // outage from the map until its own start_time arrived, on the theory
  // that a days-ahead "ПЛАНИРАНО" preview was being read as a phantom
  // active entry. That made the map look near-empty for genuinely useful
  // advance notice of upcoming work — the actual want is the opposite: show
  // every planned interruption up to 7 days out, clearly marked
  // "Планирано" (yellow) and distinct from a currently-active emergency
  // (red), not hidden until the day it starts.
  if (dbResult && dbResult.rows) {
    outages = dbResult.rows.filter((o) => ['active', 'scheduled'].includes(o.status) && new Date(o.expected_end_time) > now && isWithinMapHorizon(o));
  } else {
    outages = inMemoryDB.outages.filter((o) => ['active', 'scheduled'].includes(o.status) && new Date(o.expected_end_time) > now && isWithinMapHorizon(o));
  }

  // Every outage already has a correct lat/lng stored (set at insert/update
  // time by resolveExactCoordinates, which is synchronous — no network
  // call). This used to re-geocode every outage AND every one of its
  // affected streets through geocodeStreetWithNominatim on every single
  // request, serialized at ~1.1s per call by Nominatim's rate limit — with
  // a cold cache (e.g. right after a cache-clearing fix) that's hundreds of
  // outages × several streets each, easily 10+ minutes before the endpoint
  // could even respond, making the live map render as empty. Using the
  // already-correct stored coordinates (falling back to the synchronous,
  // network-free resolveExactCoordinates only when genuinely missing) keeps
  // this endpoint instant. Nominatim's async lookup still runs in the
  // background on scrape/update — its result just isn't something a map
  // read should ever have to wait on.
  const result = outages.map((outage) => {
    const needsFallback = !outage.lat || !outage.lng
      || (Math.abs(outage.lat - 42.6977) < 0.001 && Math.abs(outage.lng - 23.3219) < 0.001 && outage.city?.toLowerCase() !== 'софия');
    const fallbackGeo = needsFallback
      ? resolveExactCoordinates(outage.city, outage.affected_streets?.[0] || outage.raw_location_text, '', outage.region || '')
      : null;
    const lat = fallbackGeo ? fallbackGeo.lat : outage.lat;
    const lng = fallbackGeo ? fallbackGeo.lng : outage.lng;

    const sourceUrl = resolveExactOfficialSourceUrl(outage.provider, outage.city, outage.source_url, outage.utility_type);

    const affectedStreets = Array.isArray(outage.affected_streets) && outage.affected_streets.length > 0
      ? outage.affected_streets
      : [outage.city];

    // A real geocoded start/end line (see warmStreetRangeGeocode) only ever
    // exists when there's exactly one affected street — same restriction
    // parseOutageNumberRange itself applies, for the same reason (no
    // reliable way to attribute a range to one of several streets).
    const numberRange = affectedStreets.length === 1 ? parseOutageNumberRange(outage.raw_location_text) : null;

    // Real vs city-wide-fallback signal for the cross-provider merge below
    // (see index.html's "Smart merging" comment): a street that couldn't be
    // geocoded precisely falls all the way back to the settlement's own
    // center point (resolveExactCoordinates's step 3) — several genuinely
    // UNRELATED outages sharing that same generic point is already known
    // and accepted for same-utility marker grouping (see the comment above
    // globalGroups in index.html), but merging DIFFERENT providers into one
    // "Комбиниран ремонт" implies a real coordinated dig at one address, so
    // that merge must never fire off two coincidental fallback points.
    const cityCenterOf = (name) => getSettlementCoordinates(name, '', outage.region || '');
    // One bulletin can cover a town and several villages; a street belongs to the
    // settlement named just before it in the list, not always to the row's city.
    const contexts = streetContextCities(outage.city, affectedStreets, outage.region || '');

    // Софийска вода draws the affected ZONE as a polygon on its own map; the scraper stores that
    // polygon's centre as the row's coordinate. The zone text ("зона за спиране- с. Владая-
    // района заключен между ЖП линия …, ул. …") cannot be geocoded as one street — it landed on
    // the city centre (a Владая outage pinned 13 km away) or on whichever curated street name
    // happened to be a substring of it. Every entry of such a row is pinned at the zone centre.
    const zoneCentre = ZONE_CENTRE_PROVIDERS.has(outage.provider)
      && outage.lat && outage.lng && !(Math.abs(outage.lat - 42.6977) < 0.001 && Math.abs(outage.lng - 23.3219) < 0.001)
      ? { lat: outage.lat, lng: outage.lng }
      : null;

    const heatingPins = outage.provider === 'Топлофикация София' ? buildSofiaHeatingPins(outage, affectedStreets) : null;

    const streetPins = dedupeStreetPins(heatingPins || affectedStreets.map((st, idx) => {
      if (zoneCentre) return { street: st, lat: zoneCentre.lat, lng: zoneCentre.lng, precise: true, geo_precision: 'exact' };
      const pinCity = contexts[idx];
      const cityCenter = cityCenterOf(pinCity);
      // A landmark named in the notice picks the stretch of a long boulevard ("Дунав мост, бул. България 123").
      const streetCoords = curatedStreetPoint(cleanSettlementName(pinCity), st, outage.raw_location_text) || resolveExactCoordinates(pinCity, st, '', outage.region || '');
      // No cityCenter at all (region given but not even the settlement's own
      // center could be confirmed) can't be trusted as "not a fallback" just
      // because there's nothing to compare against — treat that the same as
      // a confirmed fallback rather than defaulting to precise=true on
      // missing data.
      const isCityFallback = !cityCenter || (Math.abs(streetCoords.lat - cityCenter.lat) < 0.0005 && Math.abs(streetCoords.lng - cityCenter.lng) < 0.0005);
      // Three-tier precision status for this pin, kept alongside the
      // existing boolean `precise` flag (still used as-is by the
      // cross-provider merge guard in index.html) rather than replacing it:
      // EXACT     — a real geocoded point for this specific street/number.
      // APPROXIMATE — landed on the settlement's own center (a real,
      //   correctly-identified place, just without street-level precision).
      // UNVERIFIED  — even the settlement's own center couldn't be confirmed
      //   in its claimed region/municipality (getSettlementCoordinates
      //   degraded to that area's centroid, or found nothing at all) — the
      //   pin is, at best, a rough area guess.
      let geoPrecision = !isCityFallback
        ? 'exact'
        : (!cityCenter || cityCenter.isRegionFallback ? 'unverified' : 'approximate');
      // A whole-settlement entry ("с. Опанец") IS the settlement: its centre is the right place,
      // not an approximation of a street (`precise` stays as it was — it guards the merge of
      // different providers into one "Комбиниран ремонт", which two village-wide notices at the
      // same village centre must not trigger).
      if (SETTLEMENT_ENTRY_RE.test(String(st || ''))) {
        const named = getSettlementCoordinates(String(st).replace(SETTLEMENT_ENTRY_RE, '').trim(), '', outage.region || '');
        if (named && !named.isRegionFallback) geoPrecision = 'exact';
      }
      const pin = {
        street: st,
        lat: streetCoords.lat,
        lng: streetCoords.lng,
        precise: !isCityFallback,
        geo_precision: geoPrecision
      };
      if (numberRange && numberRange.type === 'range' && numberRange.min !== numberRange.max) {
        const p1 = getCachedStreetNumberPoint(pinCity, st, numberRange.min, outage.region || '');
        const p2 = getCachedStreetNumberPoint(pinCity, st, numberRange.max, outage.region || '');
        if (p1 && p2) pin.line = [[p1.lat, p1.lng], [p2.lat, p2.lng]];
      }
      return pin;
    }));

    const startTime = outage.start_time ? new Date(outage.start_time) : null;
    const isStarted = startTime ? startTime.getTime() <= now.getTime() : true;
    const schedule = describeDailySchedule(outage, now, isStarted);
    const isActive = (outage.status === 'active' || (outage.status === 'scheduled' && isStarted)) && !schedule.between_windows;
    const isUpcoming = (outage.status === 'scheduled' && !isStarted) || schedule.between_windows;

    // See checkAddressOutageStatus() for why — some bulletins only warn a
    // disruption is POSSIBLE, not that supply will definitely be cut.
    const isOnlyPossible = isOnlyPossibleDisruption(outage.raw_location_text || '');

    return {
      id: outage.id,
      utility_type: outage.utility_type,
      provider: outage.provider,
      city: outage.city,
      // "с. X"/"гр. X" with the settlement's OWN real type from the
      // registry, not assumed — see formatSettlementLabel()'s own comment.
      // `city` itself stays the bare name unchanged (matching/filtering
      // elsewhere already depends on that), this is purely for display.
      city_label: formatSettlementLabel(outage.city, '', outage.region, outage.affected_streets),
      raw_location_text: outage.raw_location_text,
      affected_streets: affectedStreets,
      street_pins: streetPins,
      coordinates: { lat, lng },
      source_url: sourceUrl,
      start_time: outage.start_time,
      expected_end_time: outage.expected_end_time,
      // Whether the SOURCE TEXT actually states a clock time anywhere, as
      // opposed to start_time/expected_end_time being parseBulgarianDateTime's
      // own same-day 08:00-17:00 fallback guess for an open-ended "до
      // отстраняване" report with no stated time at all — confirmed live
      // this showed as a literal "08:00 – 17:00 ч." for a ВиК Берковица
      // bulletin that never said any such thing. The frontend uses this to
      // show an honest "До отстраняване на аварията" instead when false,
      // without touching the fallback timestamps themselves (still needed
      // so a dateless report doesn't stay "active" forever).
      time_is_estimated: !hasExplicitTimeInText(outage.raw_location_text),
      status: outage.status,
      is_upcoming: isUpcoming,
      has_started: isStarted,
      is_active: isActive && !isOnlyPossible,
      is_only_possible: isOnlyPossible,
      tone: (isActive && !isOnlyPossible) ? 'red' : 'yellow',
      number_scope: formatNumberScopeText(outage.raw_location_text),
      ...schedule
    };
  });

  return result;
}

// The clock windows (and whether NOW is inside one) for an announcement that cuts
// supply only in daily windows — see getDailyScheduleInfo(). Always returns the
// same three fields so callers can spread it: schedule_text (what to show in the
// "Час" row instead of first-start–last-end), between_windows (started, not over,
// but supply is on right now) and next_window_text ("днес 15:00").
export function describeDailySchedule(outage, now = new Date(), isStarted = true) {
  const info = getDailyScheduleInfo(outage.raw_location_text || '', outage.start_time, outage.expected_end_time, now);
  if (!info) return { schedule_text: '', between_windows: false, next_window_text: '' };
  const ended = outage.expected_end_time ? new Date(outage.expected_end_time).getTime() <= now.getTime() : false;
  const between = isStarted && !ended && !info.in_window;
  return {
    schedule_text: info.windows_text,
    between_windows: between,
    next_window_text: between ? info.next_window_text : ''
  };
}

// Nothing ever removed an outage record once inserted — every scrape cycle
// (every 5 minutes, forever) only appends/updates, so the table grows
// without bound. An outage past its own expected_end_time has zero
// remaining display/notification value (the live map and address-check
// both already filter to expected_end_time > now on every read, and
// notification history reads from a separate, small notification_log, not
// this table) — so it's safe to drop shortly after it ends. Originally a
// 3-day/once-daily job; tightened to 6h/hourly per explicit admin request
// once the accumulated backlog (94k+ total rows, a one-time 6,142-row
// manual cleanup) made clear the daily cadence was letting real buildup
// happen between runs — this keeps it from ever recurring, fully
// autonomously, with no admin action needed going forward.
const RETENTION_HOURS = 6;

// ── Топлофикация София: pins by district ─────────────────────────────────────
// toplo.bg names the district of every incident ("Региoн") and then lists addresses as
// block numbers ("бл.85, бл.86 …", "бл.38 А") or street groups ("ул. „Райко Алексиев“
// бл.бл.93-99, ул. „Юрий Гагарин“ …"). The rows carried the DISTRICT NAME in the region
// column, which split the geocode cache per district and made every lookup "unverified":
// a bare "Изток" was pinned 9 km away in Кремиковци, block lists landed on a fixed point in
// Красно село, street groups at the city centre. Centres below are the district boundaries'
// centres from OpenStreetMap (checked against every district toplo.bg has used so far).
export const SOFIA_DISTRICT_CENTRES = {
  'бъкстон': { lat: 42.6655, lng: 23.2700 }, 'гео милев': { lat: 42.6800, lng: 23.3629 },
  'дианабад': { lat: 42.6629, lng: 23.3479 }, 'дружба 1': { lat: 42.6549, lng: 23.4008 },
  'дружба 2': { lat: 42.6549, lng: 23.4008 }, 'дървеница': { lat: 42.6533, lng: 23.3618 },
  'изток': { lat: 42.6725, lng: 23.3570 }, 'лозенец': { lat: 42.6735, lng: 23.3257 },
  'люлин 1': { lat: 42.7287, lng: 23.2542 }, 'младост 1': { lat: 42.6582, lng: 23.3699 },
  'младост 1а': { lat: 42.6498, lng: 23.3824 }, 'младост 2': { lat: 42.6442, lng: 23.3700 },
  'младост 3': { lat: 42.6405, lng: 23.3795 }, 'полигона': { lat: 42.6640, lng: 23.3795 },
  'слатина': { lat: 42.6823, lng: 23.3741 }, 'студентски град': { lat: 42.6513, lng: 23.3479 },
  'хладилника': { lat: 42.6622, lng: 23.3213 }, 'яворов': { lat: 42.6850, lng: 23.3483 },
  'мусагеница': { lat: 42.6590, lng: 23.3630 }
};

/** Centre of a Sofia district by the name toplo.bg uses ("Слатина (Христо Смирненски)" -> слатина), or null. */
export function sofiaDistrictCentre(name) {
  const key = String(name || '').replace(/\s*\(.*\)$/, '').trim().toLowerCase();
  return ownValue(SOFIA_DISTRICT_CENTRES, key) || null;
}

const distanceKm = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 111 * Math.cos(a.lat * Math.PI / 180));

/**
 * Map pins for one Топлофикация София row, or null when its district is not one we know
 * (the generic per-street path then applies). A district entry is pinned at the district;
 * a street group is split into its streets, each looked up in Sofia and accepted only when it
 * lies inside the district's own neighbourhood (4 km) — otherwise the pin is the district
 * centre, labelled approximate; a block list ("бл.85, бл.86") has no street and stays at the district.
 */
export function buildSofiaHeatingPins(outage, entries) {
  const centre = sofiaDistrictCentre(outage.region);
  if (!centre) return null;
  const pins = [];
  const at = (street, point, exact) => pins.push({ street, lat: point.lat, lng: point.lng, precise: exact, geo_precision: exact ? 'exact' : 'approximate' });
  for (const entry of entries) {
    const asDistrict = sofiaDistrictCentre(entry);
    if (asDistrict) { at(entry, asDistrict, true); continue; }
    const streets = extractStreetsHeuristic(entry).filter((x) => !/^централна градска част$/i.test(x));
    if (streets.length === 0) { at(entry, centre, false); continue; }
    for (const st of streets) {
      const p = resolveExactCoordinates('София', st, '', '');
      const nearDistrict = p && distanceKm(p, centre) <= 4;
      const isCityCentre = Math.abs(p.lat - 42.6977) < 0.001 && Math.abs(p.lng - 23.3219) < 0.001;
      if (nearDistrict && !isCityCentre) at(st, p, true); else at(st, centre, false);
    }
  }
  return pins;
}

// ── Source synchronisation ───────────────────────────────────────────────────
// A scraper only ever adds/refreshes rows; when a provider WITHDRAWS or
// reschedules an announcement (ЕРП Север re-publishes an edited notice under a new
// key; an emergency Електрохолд listed a minute ago is restored) nothing ever
// touched the old row, so it kept showing until its own end time — sometimes days
// — while the provider's own page no longer listed it. Every upsert stamps
// updated_at, so a live row that a complete, healthy pass did NOT refresh is one
// the source no longer lists. It is closed only after it was missed by
// VANISH_REQUIRED_MISSES separate passes (one flaky response must not close
// anything), never for a scope whose fetch failed, and never in bulk (a scope
// where most rows would vanish at once is a broken page, not a real clean-up).
export const SYNC_CLOSED_PROVIDERS = new Set(['Енерго-Про (ЕРП Север)', 'EVN България', 'Електрохолд', 'Софийска вода']);
// Providers whose row coordinate is the centre of the provider's own affected-zone polygon
// (see scrapeSofiaWaterGis) — that is where the map pins go, not a geocode of the zone text.
export const ZONE_CENTRE_PROVIDERS = new Set(['Софийска вода']);
// One row per announcement key, produced deterministically from the source's structured data:
// on a key match the fresh street list replaces the stored one (see upsertOutage).
const REPLACE_ON_KEY_PROVIDERS = new Set(SYNC_CLOSED_PROVIDERS);
const VANISH_REQUIRED_MISSES = 2;
const VANISH_MIN_GAP_MS = 8 * 60 * 1000;
const VANISH_SEEN_SLACK_MS = 2 * 60 * 1000;
const vanishMisses = new Map(); // row id -> { misses, lastMissAt }
// announcement key -> { id, at } of the rows closeVanishedOutages() closed, so a source
// that lists one again re-opens exactly that row (see step 1e of upsertOutage).
const syncClosedRows = new Map();

/**
 * Pure decision step (exported for tests): which of one scope's live rows to close
 * after a pass that began at `passStartedAt`. Updates `misses` in place.
 */
export function selectVanishedRows(rows, { passStartedAt, now = Date.now(), misses = vanishMisses, requiredMisses = VANISH_REQUIRED_MISSES, minGapMs = VANISH_MIN_GAP_MS, massMinimum = 4, massShare = 0.5 } = {}) {
  const candidates = [];
  for (const row of rows) {
    const seen = new Date(row.updated_at).getTime() >= passStartedAt - VANISH_SEEN_SLACK_MS;
    if (seen) {
      misses.delete(row.id);
      continue;
    }
    const entry = misses.get(row.id) || { misses: 0, lastMissAt: 0 };
    if (now - entry.lastMissAt >= minGapMs) {
      entry.misses++;
      entry.lastMissAt = now;
    }
    misses.set(row.id, entry);
    if (entry.misses >= requiredMisses) candidates.push(row);
  }
  const massEvent = candidates.length > massMinimum && candidates.length > rows.length * massShare;
  return { closeIds: massEvent ? [] : candidates.map((r) => r.id), skippedAsMass: massEvent, missing: candidates.length };
}

/**
 * Closes the live rows of `provider` that a healthy, complete pass over each of
 * `keyPrefixes` (the scopes whose fetch succeeded) did not refresh. Call at the end
 * of a real (non-dry) scrape only.
 */
export async function closeVanishedOutages({ provider, keyPrefixes, passStartedAt }) {
  if (!Array.isArray(keyPrefixes) || keyPrefixes.length === 0) return { closed: 0, skippedScopes: [] };
  const dbResult = await query(
    `SELECT id, city, affected_streets, source_announcement_key, updated_at
     FROM outages
     WHERE provider = $1 AND status IN ('active', 'scheduled') AND expected_end_time > NOW()
       AND source_announcement_key LIKE ANY($2)`,
    [provider, keyPrefixes.map((p) => `${p}%`)]
  );
  const live = (dbResult && dbResult.rows)
    ? dbResult.rows
    : inMemoryDB.outages.filter((o) => o.provider === provider && ['active', 'scheduled'].includes(o.status)
        && new Date(o.expected_end_time).getTime() > Date.now()
        && keyPrefixes.some((p) => (o.source_announcement_key || '').startsWith(p)));

  const closeIds = [];
  const skippedScopes = [];
  for (const prefix of keyPrefixes) {
    const scopeRows = live.filter((r) => (r.source_announcement_key || '').startsWith(prefix));
    if (scopeRows.length === 0) continue;
    const verdict = selectVanishedRows(scopeRows, { passStartedAt });
    if (verdict.skippedAsMass) {
      skippedScopes.push(prefix);
      console.warn(`⚠️ [SYNC] ${provider} "${prefix}": ${verdict.missing} of ${scopeRows.length} live rows are missing from the source at once — treating it as a broken page, closing nothing.`);
    }
    closeIds.push(...verdict.closeIds);
  }

  if (closeIds.length > 0) {
    if (dbResult && dbResult.rows) {
      await query(`UPDATE outages SET status = 'resolved', updated_at = NOW() WHERE id = ANY($1)`, [closeIds]);
    } else {
      const idSet = new Set(closeIds);
      inMemoryDB.outages.forEach((o) => {
        if (idSet.has(o.id)) { o.status = 'resolved'; o.updated_at = new Date().toISOString(); }
      });
      persistLocalDB();
    }
    const closedSet = new Set(closeIds);
    for (const row of live) {
      if (closedSet.has(row.id) && row.source_announcement_key) syncClosedRows.set(row.source_announcement_key, { id: row.id, at: Date.now() });
    }
    for (const id of closeIds) vanishMisses.delete(id);
    console.log(`🔄 [SYNC] ${provider}: closed ${closeIds.length} outage(s) the source no longer lists.`);
  }
  return { closed: closeIds.length, skippedScopes };
}

let lastPruneAt = null;
let lastPruneRemoved = 0;

export function getLastPruneResult() {
  return { ranAt: lastPruneAt, removed: lastPruneRemoved };
}

export async function pruneOldOutages() {
  const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000);

  const dbResult = await query(`DELETE FROM outages WHERE expected_end_time < $1 RETURNING id`, [cutoff.toISOString()]);

  // A row closed early (withdrawn by its source, resolved by the sweep) keeps its PLANNED end time, which can be
  // weeks away (heating windows to 01.11): it sat in the table, indexes included, until then — 9,000 such rows
  // were 120 MB of the 163 MB database. Nothing reads them after the 24 h duplicate-matching window.
  await query(`DELETE FROM outages WHERE status = 'resolved' AND updated_at < NOW() - INTERVAL '48 hours'`).catch(() => {});
  // The per-run scraper statistics only matter for the health panel's recent history — it reads the last 48 hours
  // (scraperHealthService.js). Measured: ~7,700 rows a day; 30 days of that is ~230,000 rows (~65 MB of the 0.5 GB
  // free plan, and the table was already at 46 MB) for a table nobody reads past two days. Four days keeps the 48 h
  // window plus a weekend of margin and settles around 9 MB.
  await query(`DELETE FROM scraper_run_stats WHERE run_at < NOW() - INTERVAL '4 days'`).catch(() => {});
  await query(`DELETE FROM outage_reminders WHERE sent_at < NOW() - INTERVAL '14 days'`).catch(() => {});

  const beforeCount = inMemoryDB.outages.length;
  inMemoryDB.outages = inMemoryDB.outages.filter((o) => new Date(o.expected_end_time) >= cutoff);
  const removedInMemory = beforeCount - inMemoryDB.outages.length;
  if (removedInMemory > 0) persistLocalDB();

  const removedInDb = dbResult && typeof dbResult.rowCount === 'number' ? dbResult.rowCount : 0;
  const removed = removedInDb + removedInMemory;
  lastPruneAt = new Date().toISOString();
  lastPruneRemoved = removed;
  if (removed > 0) {
    console.log(`🗑️ [OUTAGE RETENTION] Pruned ${removed} outage(s) that ended more than ${RETENTION_HOURS}h ago.`);
  }
  return { removed };
}

// Self-checking data-integrity sweep — re-validates every currently
// active/scheduled outage against isAnnouncementIndicatingNoOutage() and
// auto-resolves any that fail it. This is the same check that already runs
// at scrape time (see scraperService.js), but running it again periodically
// against what's ALREADY LIVE catches two things scrape-time filtering
// can't: a record that slipped through before that filter existed/was
// wired in, and — going forward — any record that would newly fail if this
// filter's own rules get tightened later, without needing every source to
// be re-scraped first. Confirmed against real production data before this
// was built: this exact check found 10 genuinely fake/stale live records
// (company "about us" text, an already-resolved announcement) sitting on
// the public map. Marks matches 'resolved' rather than deleting — same as
// a real outage's natural end, invisible to users immediately (map/
// notifications only ever show active/scheduled), cleaned up for good by
// pruneOldOutages() on its own schedule.
let lastIntegritySweepAt = null;
let lastIntegritySweepResult = { checked: 0, resolved: 0 };

export function getLastIntegritySweepResult() {
  return { ranAt: lastIntegritySweepAt, ...lastIntegritySweepResult };
}

export async function runDataIntegritySweep() {
  let candidates = [];
  const dbResult = await query(
    // start_time/expected_end_time/status MUST be selected: the same-event
    // duplicate check below keys on them. They were missing, so that key
    // silently collapsed to provider+city+streets alone and treated every
    // separate scheduled WINDOW for the same village (ЕРП Север routinely
    // schedules one village on several different days) as a "duplicate" of
    // the newest one — resolving the rest every 20 minutes, after which the
    // next scrape re-created them (and re-fired the push notification):
    // confirmed live, ~1,200 throw-away rows in 6 hours.
    `SELECT id, provider, city, region, raw_location_text, affected_streets, created_at, start_time, expected_end_time, status FROM outages WHERE status IN ('active', 'scheduled')`,
    []
  );

  if (dbResult && dbResult.rows) {
    candidates = dbResult.rows;
  } else {
    candidates = inMemoryDB.outages
      .filter((o) => ['active', 'scheduled'].includes(o.status))
      .map((o) => ({ id: o.id, provider: o.provider, city: o.city, region: o.region, raw_location_text: o.raw_location_text, affected_streets: o.affected_streets, created_at: o.created_at, start_time: o.start_time, expected_end_time: o.expected_end_time, status: o.status }));
  }

  const badIds = candidates
    .filter((o) => isAnnouncementIndicatingNoOutage(o.raw_location_text || ''))
    .map((o) => o.id);

  // A since-fixed normalizeStreetName bug (see streetNormalizer.js) used to
  // silently merge different numbered zones of the same district (e.g.
  // Младост 1, 2, 3, 4) into one outage row via a wildcard district core
  // ("Младост 1А" lost its zone number entirely and became a bare
  // "младост" that contain-matched every other Младост zone). Fixing the
  // normalizer only stops NEW cross-zone merges going forward — a row
  // already poisoned under the old code stays poisoned until something
  // resolves it, so this sweep also actively looks for that exact bug
  // signature and resolves it, letting the next scrape recreate clean,
  // correctly-separated rows.
  //
  // The signature has to be precise: a BARE (unnumbered) entry for a
  // district COEXISTING WITH a numbered variant of the same district in one
  // row. That specific combination can only happen via the containment-
  // fallback merge this bug relied on ("тракия 3".includes("тракия")) — it
  // can never arise from a single legitimate bulletin, since scraping never
  // independently produces both a bare and a numbered form of the exact
  // same district for one real event. An earlier version of this check
  // instead flagged ANY row with 2+ DIFFERENT numbered zones (no bare-entry
  // requirement) — that's a false-positive trap: a single real bulletin can
  // legitimately list several different numbered zones of one district as
  // all affected by the same outage (e.g. "Тракия 1" and "Тракия 3" in one
  // announcement), and the old check was auto-resolving those genuine
  // outages right along with actually-poisoned rows.
  const zoneRe = /^(младост|люлин|надежда|дружба|тракия|изток|изгрев|запад|възраждане|орфей|чайка|лазур|славейков)(?:\s+(\d+[а-я]?))?$/;
  const zoneMergeIds = candidates
    .filter((o) => {
      const byDistrict = {};
      for (const s of (o.affected_streets || [])) {
        const m = normalizeStreetName(s).match(zoneRe);
        if (!m) continue;
        const entry = (byDistrict[m[1]] = byDistrict[m[1]] || { hasBare: false, numbered: 0 });
        if (m[2]) entry.numbered++;
        else entry.hasBare = true;
      }
      return Object.values(byDistrict).some((d) => d.hasBare && d.numbered > 0);
    })
    .map((o) => o.id);

  // (Removed: the "2+ different bare block numbers on one Топлофикация София
  // row = poisoned merge" rule. It targeted rows poisoned by an old
  // sameOutageMatch() bug that has long been fixed, but its premise — that
  // scrapeSofiaHeatingToplo() reports exactly ONE block per incident — stopped
  // being true when the scraper started keeping toplo.bg's own shared-prefix
  // block groups intact ("бл.354,356,356А,358,385,386,387 в кв. Младост 3" is
  // ONE real entry in the source feed). The rule then resolved every such
  // legitimate outage every 20 minutes, the next scrape re-created it, and
  // each re-creation re-fired the push notification — confirmed live, ~400
  // throw-away rows in 6 hours.)

  // Exact-text duplicates: two rows for the same provider+city whose
  // raw_location_text is byte-identical. Unlike every other check in this
  // sweep (which infers poisoning from street/date heuristics), this one is
  // unambiguous — confirmed live it's a real, recurring case: ЕРП Север's
  // own feed sometimes carries the exact same announcement twice under two
  // different "Публикувано на" timestamps (a source-side republish, not a
  // parsing bug), which — now that each publish timestamp correctly
  // produces its own distinct source_announcement_key — creates two
  // genuinely separate DB rows for what is, content-wise, one real
  // announcement. Keeps the most-recently-created row, resolves the rest —
  // same non-destructive pattern as every other category here.
  const exactDupGroups = new Map();
  for (const o of candidates) {
    if (!o.raw_location_text) continue;
    const key = `${o.provider}|${o.city}|${o.raw_location_text}`;
    if (!exactDupGroups.has(key)) exactDupGroups.set(key, []);
    exactDupGroups.get(key).push(o);
  }
  const exactDuplicateIds = [];
  for (const group of exactDupGroups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    for (let i = 1; i < group.length; i++) exactDuplicateIds.push(group[i].id);
  }

  // Retroactive cleanup for the "проверете"/"клон" stopwords added to
  // extractStreetsHeuristic() (aiParserService.js): a row created BEFORE
  // those fixes landed can still carry a leftover contaminated fragment
  // (e.g. "село Калипетрово.. Проверете", picked up from ЕРП Север's own
  // "Проверете за Вашия обект тук" footer) merged into affected_streets —
  // confirmed live on production. The stopword fix only stops NEW
  // contaminated fragments from being extracted; it can't retroactively
  // clean what's already stored, since merge is additive and never drops
  // anything. Unlike the sweeps above, a contaminated fragment doesn't
  // invalidate the whole outage — its OTHER streets are still real and
  // live — so this strips just the bad fragment(s) from the array in place
  // instead of resolving the whole row.
  const isContaminatedFragment = (s) => {
    const lower = (s || '').toLowerCase();
    return (
      /(?:^|[^а-я])проверете(?:$|[^а-я])/.test(lower) ||
      /(?:^|[^а-я])клон(?:$|[^а-я])/.test(lower)
    );
  };
  const streetCleanups = [];
  for (const o of candidates) {
    const original = o.affected_streets || [];
    const cleaned = original.filter((s) => !isContaminatedFragment(s));
    if (cleaned.length !== original.length) {
      streetCleanups.push({ id: o.id, cleaned: cleaned.length > 0 ? cleaned : ['Централна градска част'] });
    }
  }

  if (streetCleanups.length > 0) {
    if (dbResult && dbResult.rows) {
      for (const c of streetCleanups) {
        await query(`UPDATE outages SET affected_streets = $1, updated_at = NOW() WHERE id = $2`, [c.cleaned, c.id]);
      }
    } else {
      const cleanupMap = new Map(streetCleanups.map((c) => [c.id, c.cleaned]));
      inMemoryDB.outages.forEach((o) => {
        if (cleanupMap.has(o.id)) {
          o.affected_streets = cleanupMap.get(o.id);
          o.updated_at = new Date().toISOString();
        }
      });
      persistLocalDB();
    }
    console.warn(`🧹 [DATA INTEGRITY SWEEP] Stripped contaminated street fragment(s) from ${streetCleanups.length} outage(s).`);
  }

  // Retroactive cleanup for the general "any single shared street merges two
  // different real outages" bug in sameOutageMatch() (streetNormalizer.js,
  // see its own comment for the full story): before the proportional-overlap
  // requirement was added there, two completely unrelated ЕРП Север/EVN
  // България bulletins for different towns could merge into one record
  // purely because each happened to list one nationwide-common street name
  // (e.g. "ул. Дунав") — confirmed live, one pair of Варна-region records
  // had already cross-contaminated to ~40 streets spanning several unrelated
  // towns. That fix only stops NEW cross-contamination; a row already
  // poisoned stays poisoned. Both providers are 100% heuristic-parsed
  // (parseOutageTextHeuristic -> extractStreetsHeuristic(raw_location_text),
  // never AI) and raw_location_text is always overwritten with the LATEST
  // single scrape's own text (never merged) — so re-running the same
  // extraction against a row's own stored raw_location_text reliably
  // reproduces exactly what that row's affected_streets SHOULD be right now,
  // discarding anything merged in from unrelated past scrapes. Self-
  // correcting: a row that was never poisoned re-extracts to the same list
  // it already has, so this only ever shrinks a row that's actually
  // contaminated — the >=5-and-majority-extra threshold below exists only to
  // avoid treating small legitimate wording/case drift as poisoning.
  const HEURISTIC_ONLY_PROVIDERS = new Set(['Енерго-Про (ЕРП Север)', 'EVN България']);
  const reExtractionFixes = [];
  for (const o of candidates) {
    if (!HEURISTIC_ONLY_PROVIDERS.has(o.provider) || !o.raw_location_text) continue;
    const fresh = extractStreetsHeuristic(o.raw_location_text);
    const current = o.affected_streets || [];
    const freshLower = new Set(fresh.map((s) => s.toLowerCase().trim()));
    const extraCount = current.filter((s) => !freshLower.has((s || '').toLowerCase().trim())).length;
    if (extraCount >= 5 && extraCount > fresh.length) {
      reExtractionFixes.push({ id: o.id, cleaned: fresh.length > 0 ? fresh : ['Централна градска част'] });
    }
  }

  if (reExtractionFixes.length > 0) {
    if (dbResult && dbResult.rows) {
      for (const c of reExtractionFixes) {
        await query(`UPDATE outages SET affected_streets = $1, updated_at = NOW() WHERE id = $2`, [c.cleaned, c.id]);
      }
    } else {
      const fixMap = new Map(reExtractionFixes.map((c) => [c.id, c.cleaned]));
      inMemoryDB.outages.forEach((o) => {
        if (fixMap.has(o.id)) {
          o.affected_streets = fixMap.get(o.id);
          o.updated_at = new Date().toISOString();
        }
      });
      persistLocalDB();
    }
    console.warn(`🧹 [DATA INTEGRITY SWEEP] Re-extracted ${reExtractionFixes.length} cross-contaminated ЕРП Север/EVN outage(s) from their own stored announcement text.`);
  }

  // Broader duplicate net than exactDuplicateIds above: two rows for the
  // SAME real event (provider+city+affected_streets+start_time+
  // expected_end_time+status all matching) whose raw_location_text differs
  // slightly — e.g. ЕРП Север re-publishing the same announcement with a
  // different "Публикувано на" timestamp line, which exactDuplicateIds'
  // byte-identical check doesn't catch. National generalization of the
  // one-off cleanup run by hand for ВиК Русе earlier (root cause: an
  // unstable synthetic sourceUrl fingerprint, fixed in scraperService.js's
  // buildItemFingerprint()). Deliberately keyed on the FULL tuple including
  // both dates, not just provider+street — two rows for the same street
  // with genuinely different dates (confirmed live: ЕРП Север/Лясковец, one
  // window 21.09 and a separate one 23-25.09) are two real, separate
  // scheduled maintenance windows, not a duplicate.
  const broadDupGroups = new Map();
  for (const o of candidates) {
    const key = [o.provider, o.city, JSON.stringify(o.affected_streets), o.start_time, o.expected_end_time, o.status].join('|');
    if (!broadDupGroups.has(key)) broadDupGroups.set(key, []);
    broadDupGroups.get(key).push(o);
  }
  const broadDuplicateIds = [];
  for (const group of broadDupGroups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    for (let i = 1; i < group.length; i++) broadDuplicateIds.push(group[i].id);
  }

  // A truncated fragment of another live notice: ВиК Бургас's CMS put "…ще бъде спряно водоподаването в" and
  // "кв.Долно Езерово по улиците …" into two paragraphs, so the first half was saved on its own with the generic
  // "Централна градска част"; once the halves are joined the complete row exists next to it. A generic-only row
  // whose text is the beginning of a longer live row's text (same provider and city) is that fragment.
  const fragmentIds = [];
  const GENERIC_ONLY = /^централна градска част$/i;
  for (const o of candidates) {
    if (!Array.isArray(o.affected_streets) || o.affected_streets.length !== 1 || !GENERIC_ONLY.test(o.affected_streets[0])) continue;
    const head = String(o.raw_location_text || '').trim();
    if (head.length < 25) continue;
    if (candidates.some((p) => p.id !== o.id && p.provider === o.provider && p.city === o.city
        && String(p.raw_location_text || '').length > head.length && String(p.raw_location_text || '').startsWith(head)
        && !(Array.isArray(p.affected_streets) && p.affected_streets.length === 1 && GENERIC_ONLY.test(p.affected_streets[0])))) {
      fragmentIds.push(o.id);
    }
  }

  // A Топлофикация София row carrying the name of ANOTHER district as one of its entries was merged across districts
  // (see matchesOutage): resolved, so the next scrape recreates each notice under its own district.
  const districtMergeIds = candidates
    .filter((o) => o.provider === 'Топлофикация София' && o.region && sofiaDistrictCentre(o.region)
      && (o.affected_streets || []).some((e) => { const c = sofiaDistrictCentre(e); return c && c !== sofiaDistrictCentre(o.region); }))
    .map((o) => o.id);

  const allBadIds = Array.from(new Set([...badIds, ...zoneMergeIds, ...exactDuplicateIds, ...broadDuplicateIds, ...fragmentIds, ...districtMergeIds]));

  if (allBadIds.length > 0) {
    if (dbResult && dbResult.rows) {
      await query(`UPDATE outages SET status = 'resolved', updated_at = NOW() WHERE id = ANY($1)`, [allBadIds]);
    } else {
      const badIdSet = new Set(allBadIds);
      let changed = false;
      inMemoryDB.outages.forEach((o) => {
        if (badIdSet.has(o.id)) {
          o.status = 'resolved';
          o.updated_at = new Date().toISOString();
          changed = true;
        }
      });
      if (changed) persistLocalDB();
    }
    console.warn(`🧹 [DATA INTEGRITY SWEEP] Auto-resolved ${badIds.length} fake announcement(s), ${zoneMergeIds.length} zone-merge-poisoned outage(s), ${exactDuplicateIds.length} exact-text duplicate(s), and ${broadDuplicateIds.length} same-event duplicate(s), ${fragmentIds.length} truncated fragment(s) (checked ${candidates.length}).`);
  }

  // Re-warms the live Nominatim geocode cache for every affected_streets
  // entry still carrying a "местност"/"м-ст"/"м-т" locality prefix — these
  // previously produced a ZERO-result Nominatim query (fixed in
  // geocodingService.js's cleanStreetForSearch(), which now strips the
  // prefix before searching) and so were silently falling back to the
  // outage's own city-center point instead of their own real location.
  // geocodeStreetWithNominatim() checks its own cache first, so re-running
  // this every sweep is cheap for anything already resolved (instant cache
  // hit, no network call) — it only spends real time (rate-limited ~1.1s
  // apart) on names still genuinely unresolved, which is worth retrying
  // periodically since OSM's own data coverage can improve over time.
  // Capped so a sudden large batch of new unresolved names can't stretch a
  // single sweep run unreasonably long; any excess just gets picked up by
  // the next sweep 20 minutes later.
  const MAX_LOCALITY_LOOKUPS_PER_SWEEP = 40;
  const localityJobs = new Map();
  for (const o of candidates) {
    for (const s of (o.affected_streets || [])) {
      if (/^(?:местност|м-ст|м-т)\s+/i.test(s) && !localityJobs.has(s)) {
        localityJobs.set(s, { city: o.city, region: o.region || '' });
        if (localityJobs.size >= MAX_LOCALITY_LOOKUPS_PER_SWEEP) break;
      }
    }
    if (localityJobs.size >= MAX_LOCALITY_LOOKUPS_PER_SWEEP) break;
  }
  let localitiesWarmed = 0;
  for (const [street, { city, region }] of localityJobs) {
    try {
      await geocodeStreetWithNominatim(city, street, '', region);
      localitiesWarmed++;
    } catch (e) {
      // Graceful skip — geocodeStreetWithNominatim already falls back internally on error
    }
  }

  lastIntegritySweepAt = new Date().toISOString();
  lastIntegritySweepResult = { checked: candidates.length, resolved: allBadIds.length, streetsCleaned: streetCleanups.length, reExtracted: reExtractionFixes.length, exactDuplicates: exactDuplicateIds.length, broadDuplicates: broadDuplicateIds.length, localitiesWarmed };
  return lastIntegritySweepResult;
}
