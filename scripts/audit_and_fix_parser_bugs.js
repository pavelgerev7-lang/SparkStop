// One-off diagnostic + safe-fix sweep for the 4 parsing bug categories
// found and fixed in the shared pipeline this session (textCleaner.js /
// aiParserService.js). Run manually against the live Postgres DB:
//   node scripts/audit_and_fix_parser_bugs.js
//
// Each category's fix is scoped as narrowly as the actual bug allows —
// see the inline notes on why category 2 and 4 aren't simply "re-run the
// heuristic on everything and overwrite": doing that blindly was tried
// during investigation and found to risk DESTROYING real information for
// outages that never went through the heuristic path in production (most
// providers use AI/Gemini parsing, not extractStreetsHeuristic — see the
// HEURISTIC_ONLY_PROVIDERS note below), or that had genuinely different
// text on a later re-scrape (comparing against a stale stored value isn't
// a fair test). This script only fixes what it can verify is safe.
import { query } from '../src/config/db.js';
import { extractStreetsHeuristic, hasExplicitTimeInText, parseBulgarianDateTime } from '../src/services/aiParserService.js';
import { cleanSettlementName, geocodeStreetWithNominatim, getSettlementCoordinates } from '../src/services/geocodingService.js';

const HEURISTIC_ONLY_PROVIDERS = new Set(['Енерго-Про (ЕРП Север)', 'EVN България']);
// Confirmed live: ВиК Русе's scraped text is ALSO heuristic-parsed in
// production (verified by reproducing its exact stored bug byte-for-byte
// via parseBulgarianDateTime before fixing it) — added here after that
// specific investigation, not assumed.
const CONFIRMED_HEURISTIC_PROVIDERS = new Set([...HEURISTIC_ONLY_PROVIDERS, 'ВиК Русе']);

async function main() {
  const { rows } = await query(
    "SELECT id, city, region, provider, affected_streets, raw_location_text, status, start_time, expected_end_time, updated_at, lat, lng FROM outages WHERE status IN ('active','scheduled')",
    []
  );
  console.log(`\nScanning ${rows.length} active/scheduled outages across the whole country...\n`);

  const report = {
    category1_bareCityAsStreet: { checked: rows.length, fixed: 0 },
    category2_fabricatedTime: { checked: rows.length, currentlyEstimated: 0, note: 'display-only fix, no DB write needed' },
    category3_truncatedNumberRange: { checked: rows.length, flagged: 0, flaggedIds: [] },
    category5_dateAsTime: { fixed: 0 },
    category4_missedSettlements: { checked: 0, fixed: 0, skippedNonHeuristicProviders: 0 }
  };

  // ---------------------------------------------------------------------
  // Category 1: affected_streets contains a bare "гр. X"/"град X" entry
  // that EXACTLY restates the outage's own city, alongside at least one
  // more specific entry. Exact-match only (not "starts with"/"includes")
  // — a looser match was tried first and caught real addresses like
  // "гр. Аксаково - ул. Акация" as false positives, which would have
  // deleted the only mention of a real street.
  // ---------------------------------------------------------------------
  for (const row of rows) {
    if (!Array.isArray(row.affected_streets) || row.affected_streets.length <= 1) continue;
    const cleanCity = cleanSettlementName(row.city);
    const isBareCityExact = (s) => {
      const m = s.match(/^(?:гр\.|град)\s+(.+)$/i);
      if (!m) return false;
      const captured = m[1].trim().toLowerCase().replace(/[.,;:!?-]+$/, '').trim();
      return captured === cleanCity;
    };
    const bare = row.affected_streets.filter(isBareCityExact);
    const specific = row.affected_streets.filter((s) => !isBareCityExact(s));
    if (bare.length > 0 && specific.length > 0) {
      await query('UPDATE outages SET affected_streets = $1, updated_at = NOW() WHERE id = $2', [specific, row.id]);
      report.category1_bareCityAsStreet.fixed++;
    }
  }

  // ---------------------------------------------------------------------
  // Category 2: fabricated same-day 08:00-17:00 fallback shown as if it
  // were a real stated time. This is a DISPLAY-layer fix (time_is_estimated,
  // computed live from raw_location_text on every API read) — nothing to
  // write to the DB, the stored start_time/expected_end_time are still
  // needed internally so a dateless "until fixed" report doesn't stay
  // "active" forever. Just reporting how many CURRENTLY active outages
  // this affects, for visibility.
  // ---------------------------------------------------------------------
  for (const row of rows) {
    if (row.raw_location_text && !hasExplicitTimeInText(row.raw_location_text)) {
      report.category2_fabricatedTime.currentlyEstimated++;
    }
  }

  // ---------------------------------------------------------------------
  // Category 3: a "от бл. X до бл. Y"-style range truncated mid-range by
  // the old sentence-splitter bug (fixed in textCleaner.js — this only
  // flags EXISTING rows scraped before that fix deployed, for a human to
  // glance at; auto-correcting raw_location_text would require re-fetching
  // each source page, out of scope for a DB-only script). Pattern: an
  // abbreviation immediately followed by end-of-clause with no number.
  // ---------------------------------------------------------------------
  const truncationPattern = /\b(?:бл|ул|бул|кв|пл|№)\.\s*(?:[.!?]|$)/i;
  for (const row of rows) {
    if (row.raw_location_text && truncationPattern.test(row.raw_location_text)) {
      report.category3_truncatedNumberRange.flagged++;
      report.category3_truncatedNumberRange.flaggedIds.push(row.id);
    }
  }

  // ---------------------------------------------------------------------
  // Category 4: a village/settlement silently swallowed into the
  // previous match by the old greedy-regex + stopword bug (fixed in
  // aiParserService.js). Only re-derivable for providers that actually go
  // through extractStreetsHeuristic in production — for AI-parsed
  // providers, "stored" came from Gemini's own JSON, not this function, so
  // comparing against it isn't a valid test (confirmed during
  // investigation: it flagged ~9 Sofia-provider records as "different"
  // that were really just AI vs. heuristic formatting differences, not
  // bugs — re-running blindly there risks overwriting good AI-parsed data
  // with a worse heuristic guess).
  // ---------------------------------------------------------------------
  const heuristicRows = rows.filter((r) => CONFIRMED_HEURISTIC_PROVIDERS.has(r.provider));
  report.category4_missedSettlements.checked = heuristicRows.length;
  report.category4_missedSettlements.skippedNonHeuristicProviders = rows.length - heuristicRows.length;
  for (const row of heuristicRows) {
    if (!row.raw_location_text) continue;
    const fresh = extractStreetsHeuristic(row.raw_location_text);
    const stored = row.affected_streets || [];
    // Recovers missed items (the original bug 4), AND upgrades a stale
    // single "Централна градска част" placeholder to a real name the
    // bare-settlement fallback can now find — but never accepts a fresh
    // result that's LESS informative than what's already stored.
    const freshIsBetter = fresh.length > stored.length
      || (stored.length === 1 && stored[0] === 'Централна градска част' && fresh.length === 1 && fresh[0] !== 'Централна градска част');
    if (freshIsBetter) {
      await query('UPDATE outages SET affected_streets = $1, updated_at = NOW() WHERE id = $2', [fresh, row.id]);
      report.category4_missedSettlements.fixed++;
    }
  }

  // ---------------------------------------------------------------------
  // Category 5: ВиК Русе's own "DD.MM HH:MM - DD.MM HH:MM" format had its
  // date misread as a clock time (fixed in aiParserService.js — see the
  // fullTimeRangeMatch comment), which also kept the "завършен" status
  // override (added alongside it) from ever having a chance to matter for
  // these existing rows. Only re-derives for CONFIRMED_HEURISTIC_PROVIDERS
  // — this provider was specifically verified (not assumed) to be
  // heuristic-parsed in production before being added to that set.
  // ---------------------------------------------------------------------
  for (const row of heuristicRows) {
    if (!row.raw_location_text) continue;
    const fresh = parseBulgarianDateTime(row.raw_location_text);
    const storedEndIso = row.expected_end_time ? new Date(row.expected_end_time).toISOString() : null;
    if (fresh.expected_end_time !== storedEndIso || fresh.status !== row.status) {
      await query('UPDATE outages SET start_time = $1, expected_end_time = $2, status = $3, updated_at = NOW() WHERE id = $4', [fresh.start_time, fresh.expected_end_time, fresh.status, row.id]);
      report.category5_dateAsTime.fixed++;
    }
  }

  // ---------------------------------------------------------------------
  // Category 6: exact-duplicate rows for the SAME real event — same
  // provider+city+affected_streets+start_time+expected_end_time+status.
  // This is the national generalization of the one-off cleanup already run
  // by hand for ВиК Русе earlier this session (root cause: an unstable
  // synthetic sourceUrl fingerprint, fixed in scraperService.js's
  // buildItemFingerprint()) — collapses each group down to the most
  // recently updated row (freshest/most-complete data), deleting the rest.
  // Deliberately NOT "same street ignoring date" — see the ЕРП Север
  // Лясковец case investigated this session: two rows for the same street
  // with genuinely different dates (21.09 vs 23-25.09) are two real,
  // separate scheduled maintenance windows, not a duplicate.
  // ---------------------------------------------------------------------
  const dupGroups = new Map();
  for (const row of rows) {
    const key = [row.provider, row.city, JSON.stringify(row.affected_streets), row.start_time, row.expected_end_time, row.status].join('|');
    if (!dupGroups.has(key)) dupGroups.set(key, []);
    dupGroups.get(key).push(row);
  }
  let duplicatesRemoved = 0;
  const dupGroupsAffected = [];
  for (const [key, group] of dupGroups) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
    const remove = sorted.slice(1).map((r) => r.id);
    await query('DELETE FROM outages WHERE id = ANY($1)', [remove]);
    duplicatesRemoved += remove.length;
    dupGroupsAffected.push({ provider: group[0].provider, city: group[0].city, streets: group[0].affected_streets, removed: remove.length });
  }

  // ---------------------------------------------------------------------
  // Category 7: re-warm the live Nominatim geocode cache for every
  // affected_streets entry still carrying a "местност"/"м-ст"/"м-т"
  // locality prefix — these previously produced a ZERO-result Nominatim
  // query (fixed in geocodingService.js's cleanStreetForSearch(), which
  // now strips the prefix before searching) and so were silently falling
  // back to the outage's own city-center point. Re-running the (now-fixed)
  // query here warms resolveExactCoordinates()'s synchronous read-time
  // cache for every currently-affected locality name in one pass, instead
  // of waiting for each one's own outage to happen to get re-scraped.
  // Serialized 1.1s apart by geocodeStreetWithNominatim's own shared queue
  // (Nominatim's usage policy), so this section alone takes roughly
  // (unique locality count) seconds — small in practice (tens, not
  // hundreds, of genuinely distinct names across the whole country).
  // ---------------------------------------------------------------------
  const localityJobs = new Map(); // name -> { city, region }
  for (const row of rows) {
    for (const s of (row.affected_streets || [])) {
      if (/^(?:местност|м-ст|м-т)\s+/i.test(s) && !localityJobs.has(s)) {
        localityJobs.set(s, { city: row.city, region: row.region || '' });
      }
    }
  }
  let localitiesWarmed = 0;
  let localitiesResolvedPrecisely = 0;
  const cityFallbackCache = new Map();
  for (const [street, { city, region }] of localityJobs) {
    try {
      const result = await geocodeStreetWithNominatim(city, street, '', region);
      localitiesWarmed++;
      if (!cityFallbackCache.has(city)) {
        cityFallbackCache.set(city, getSettlementCoordinates(city, '', region));
      }
      const cityCenter = cityFallbackCache.get(city);
      const isCityFallback = cityCenter && Math.abs(result.lat - cityCenter.lat) < 0.0005 && Math.abs(result.lng - cityCenter.lng) < 0.0005;
      if (!isCityFallback) localitiesResolvedPrecisely++;
    } catch (e) {
      // Graceful skip — geocodeStreetWithNominatim already falls back internally on error
    }
  }

  // ---------------------------------------------------------------------
  // Category 8: stored coordinate implausibly far (>80km) from the outage's
  // OWN claimed settlement's real registry coordinate — the systematic
  // version of the "с. Дойранци" bug just fixed (a registry data error +
  // a region-unaware geocode cache put 2 real live outages ~300km off).
  // Only auto-corrects when the registry lookup for THIS row's own
  // city+region resolves confidently (a real, specific match) — never
  // guesses when it can't verify.
  // ---------------------------------------------------------------------
  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  let implausibleFixed = 0;
  const implausibleExamples = [];
  for (const row of rows) {
    if (!row.lat || !row.lng || !row.city) continue;
    const expected = getSettlementCoordinates(row.city, '', row.region || '');
    if (!expected) continue;
    const distKm = haversineKm(row.lat, row.lng, expected.lat, expected.lng);
    if (distKm > 80) {
      await query('UPDATE outages SET lat = $1, lng = $2, updated_at = NOW() WHERE id = $3', [expected.lat, expected.lng, row.id]);
      implausibleFixed++;
      implausibleExamples.push({ city: row.city, region: row.region, provider: row.provider, distKm: distKm.toFixed(0) });
    }
  }

  console.log('====================================================');
  console.log('AUDIT REPORT');
  console.log('====================================================');
  console.log(`Category 1 (гр./град X as a fake street):    ${report.category1_bareCityAsStreet.fixed} fixed  (of ${report.category1_bareCityAsStreet.checked} checked)`);
  console.log(`Category 2 (fabricated 08:00-17:00 display):  ${report.category2_fabricatedTime.currentlyEstimated} currently show the honest "До отстраняване" label (of ${report.category2_fabricatedTime.checked} checked) — display-only, no DB write needed`);
  console.log(`Category 3 (truncated number range):          ${report.category3_truncatedNumberRange.flagged} flagged for manual review (of ${report.category3_truncatedNumberRange.checked} checked)`);
  if (report.category3_truncatedNumberRange.flaggedIds.length > 0) {
    console.log(`   IDs: ${report.category3_truncatedNumberRange.flaggedIds.join(', ')}`);
  }
  console.log(`Category 4 (missed settlement in a list/range): ${report.category4_missedSettlements.fixed} fixed  (of ${report.category4_missedSettlements.checked} heuristic-path outages checked; ${report.category4_missedSettlements.skippedNonHeuristicProviders} AI-parsed outages skipped — not a valid re-derivation test, see comment above)`);
  console.log(`Category 5 (date misread as time / ignored завършен status): ${report.category5_dateAsTime.fixed} fixed (of ${heuristicRows.length} heuristic-path outages checked)`);
  console.log(`Category 6 (exact-duplicate rows, national): ${duplicatesRemoved} removed across ${dupGroupsAffected.length} groups`);
  if (dupGroupsAffected.length > 0) {
    for (const g of dupGroupsAffected.slice(0, 20)) {
      console.log(`   ${g.provider} / ${g.city} — ${JSON.stringify(g.streets)} — removed ${g.removed} duplicate(s)`);
    }
    if (dupGroupsAffected.length > 20) console.log(`   ... and ${dupGroupsAffected.length - 20} more groups`);
  }
  console.log(`Category 7 (locality geocoding re-warm, national): ${localitiesWarmed} unique localities re-queried, ${localitiesResolvedPrecisely} now resolve to a precise point distinct from their city's own fallback center`);
  console.log(`Category 8 (implausible stored coordinate, >80km from own settlement): ${implausibleFixed} fixed`);
  for (const ex of implausibleExamples.slice(0, 20)) {
    console.log(`   ${ex.provider} / ${ex.city} (${ex.region}) — was ${ex.distKm}km off`);
  }
  console.log('====================================================\n');

  process.exit(0);
}

main().catch((e) => {
  console.error('Audit script failed:', e);
  process.exit(1);
});
