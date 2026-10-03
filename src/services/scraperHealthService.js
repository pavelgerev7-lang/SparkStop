import { query } from '../config/db.js';

/**
 * Durable per-provider scrape-result history, distinct from
 * urlHealthService.js — that module only confirms a provider's URL
 * returns HTTP 200; it has no way to notice that the page came back empty
 * or restructured and the scraper silently extracted zero real outages
 * from it. That exact gap (URL reachable, extraction producing 0) was the
 * actual root cause behind the Електрохолд, Софийска вода, and ВиК Стара
 * Загора bugs found earlier this session — none of them would have
 * tripped a URL-reachability check. This tracks the scraper's OWN
 * found/parsed/saved counts every run so a silent regression shows up in
 * the logs (and an admin endpoint) automatically, without waiting for a
 * user to notice a city looks empty.
 */
export async function recordScraperRun(provider, { found = 0, parsed = 0, saved = 0, error = null } = {}) {
  // An offline audit run from another machine (its own network, its own blocks) must not leave runs in the
  // shared history: a provider that refuses THAT address would show up as a regression in production's panel.
  if (process.env.SPARKSTOP_AUDIT_NO_STATS === '1') return;
  try {
    await query(
      `INSERT INTO scraper_run_stats (provider, found, parsed, saved, error) VALUES ($1, $2, $3, $4, $5)`,
      [provider, found, parsed, saved, error]
    );
  } catch (e) {
    // Never let health-tracking itself break a scrape run.
    console.warn(`⚠️ [SCRAPER HEALTH] Failed to record stats for ${provider}:`, e.message);
  }
}

/**
 * console.log's the same funnel line every dedicated/generic scraper
 * already printed, AND persists it — single call site so nothing
 * forgets to do both.
 */
export async function logAndRecordScraperStats(provider, { found = 0, parsed = 0, saved = 0, error = null, label = 'Открити съобщения' } = {}) {
  console.log(`📊 [${provider} Scraper] ${label}: ${found}, Успешно парснати: ${parsed}, Записани в DB: ${saved}`);
  await recordScraperRun(provider, { found, parsed, saved, error });
}

// A provider that has NEVER once returned a nonzero count in its recent
// history (small towns/villages genuinely can go weeks without a single
// real outage, and some sources — Аресгаз, most small gas utilities —
// are confirmed to legitimately sit at 0 almost always) shouldn't fire an
// alert just for continuing to be 0. Only a provider with a real recent
// track record of finding things, that then drops to 0/error, is a
// meaningful regression worth flagging.
const MIN_HISTORICAL_RUNS = 3;
const LOOKBACK_RUNS = 8;

// Providers that are no longer scraped at all. Their last run stays in the
// table for the 48 h look-back window, and the health panel would keep showing
// (and warning about) a source that no longer exists — so they are filtered
// out of the panel and the regression check instead of waiting them out.
//   ВиК Велинград — domain expired (parked); the town is now served by
//   ВиК Пазарджик, which is scraped.
export const RETIRED_PROVIDERS = new Set(['ВиК Велинград']);

// This many providers regressing at once is treated as one shared cause (the
// server's address being refused), not as separate broken scrapers. A normal
// day has 0-3 real regressions.
export const MASS_REGRESSION_THRESHOLD = 8;

/** { count, providers } when enough providers regressed together, else null. */
export function buildMassEvent(alerts) {
  const visible = (alerts || []).filter((a) => !RETIRED_PROVIDERS.has(a.provider));
  return visible.length >= MASS_REGRESSION_THRESHOLD
    ? { count: visible.length, providers: visible.map((a) => a.provider) }
    : null;
}

/**
 * Compares each provider's most recent run against its own last
 * LOOKBACK_RUNS-1 runs. Flags a provider whose current run found 0 (or
 * errored) while its recent history shows it's normally NOT zero — the
 * "site's still up but extraction silently broke" signature. Never
 * deletes or touches outage data itself — existing rows from a provider's
 * last healthy run simply stay visible (upsertOutage/runScraperJob never
 * delete on an empty scrape), so a real "fallback to last known good
 * data" already happens by construction; this function only adds the
 * missing piece, which is making the regression itself visible instead of
 * silent.
 */
export async function checkForScraperRegressions() {
  try {
    const res = await query(
      `SELECT DISTINCT ON (provider, rn) provider, found, error, run_at, rn FROM (
         SELECT provider, found, error, run_at,
                ROW_NUMBER() OVER (PARTITION BY provider ORDER BY run_at DESC) AS rn
         FROM scraper_run_stats
         WHERE run_at > NOW() - INTERVAL '48 hours'
       ) t
       WHERE rn <= $1
       ORDER BY provider, rn`,
      [LOOKBACK_RUNS]
    );
    if (!res || !res.rows) return [];

    const byProvider = new Map();
    for (const row of res.rows) {
      if (RETIRED_PROVIDERS.has(row.provider)) continue;
      if (!byProvider.has(row.provider)) byProvider.set(row.provider, []);
      byProvider.get(row.provider).push(row);
    }

    const alerts = [];
    for (const [provider, runs] of byProvider.entries()) {
      // runs[0] is the most recent (rn=1); rest is history to compare against.
      const [latest, ...history] = runs;
      if (history.length < MIN_HISTORICAL_RUNS) continue;

      const historicalNonZeroCount = history.filter((r) => r.found > 0 && !r.error).length;
      const historicallyHealthy = historicalNonZeroCount >= Math.ceil(history.length * 0.5);
      const currentlyBroken = latest.found === 0 || !!latest.error;

      if (historicallyHealthy && currentlyBroken) {
        alerts.push({
          provider,
          latest_found: latest.found,
          latest_error: latest.error,
          historical_nonzero_runs: `${historicalNonZeroCount}/${history.length}`,
          last_run_at: latest.run_at
        });
      }
    }

    if (alerts.length > 0) {
      console.warn(`\n🚨 [SCRAPER HEALTH ALERT] ${alerts.length} provider(s) that normally find outages returned nothing this run:`);
      alerts.forEach((a) => {
        console.warn(`   ✗ ${a.provider}: found=${a.latest_found}${a.latest_error ? `, error="${a.latest_error}"` : ''} (healthy in ${a.historical_nonzero_runs} recent runs) — existing rows from its last good run are still being served, nothing was wiped.`);
      });
    }

    return alerts;
  } catch (e) {
    console.warn('⚠️ [SCRAPER HEALTH] Regression check failed:', e.message);
    return [];
  }
}

/**
 * Latest run per provider (for an admin dashboard) plus whether it's
 * currently flagged as a regression.
 */
export async function getScraperHealthSummary() {
  const res = await query(
    `SELECT DISTINCT ON (provider) provider, found, parsed, saved, error, run_at
     FROM scraper_run_stats
     WHERE run_at > NOW() - INTERVAL '48 hours'
     ORDER BY provider, run_at DESC`,
    []
  );
  const alerts = await checkForScraperRegressions();
  const alertedProviders = new Set(alerts.map((a) => a.provider));

  // Many providers dropping to 0 in the SAME cycle is not many broken scrapers —
  // it is the server's outgoing address being refused by their hosting (seen on
  // 2026-09-23 and twice on 2026-09-24, each time right after a restart gave the
  // service a different outgoing address; 21 sites went to 0 together and came
  // back together, while the same pages read fine from another machine). The
  // panel shows that as ONE explained event instead of 21 red alarms.
  return {
    mass_event: buildMassEvent(alerts),
    checked_at: new Date().toISOString(),
    providers: (res?.rows || []).filter((r) => !RETIRED_PROVIDERS.has(r.provider)).map((r) => ({ ...r, regression: alertedProviders.has(r.provider) })),
    regression_count: alerts.length,
    regressions: alerts
  };
}
