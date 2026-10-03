import { PROVIDER_TARGETS, scrapeProviderTargetItems } from './scraperService.js';
import { parseOutageTextHeuristic } from './aiParserService.js';

// On-demand, admin-triggered audit that checks every PROVIDER_TARGETS entry
// directly against its live site — the same question this session kept
// re-answering by hand ("is what we show actually true, at the right place,
// from the right source?"). Reuses scrapeProviderTargetItems() (the exact
// fetch + extraction + fake-announcement filter runScraperJob() itself
// runs), so this can never silently drift from what the real scraper
// actually does — a separately-maintained copy of that logic already
// produced one false alarm before being fixed to import the real thing.
//
// Deliberately does NOT call the AI parser or upsertOutage() — this is a
// read-only content check, not a scrape run, and must never write outage
// records or cost Gemini quota. The heuristic parser alone is enough to
// catch the two classes of case worth flagging automatically:
//   - a source page returning nothing right now (informational, not
//     necessarily a bug — most small providers have no active outage most
//     of the time)
//   - a date that could only be a parsing mistake (far in the past despite
//     a genuinely current-looking bulletin, or an end before its own start)
// It deliberately does NOT flag far-FUTURE dates as suspicious — confirmed
// live this session that officially published planned maintenance
// routinely runs a week or more ahead, so that signal alone isn't reliable.

let lastAuditAt = null;
let lastAuditReport = null;
let auditInProgress = false;

function checkDateSanity(parsed, now) {
  const issues = [];
  const start = new Date(parsed.start_time);
  const end = new Date(parsed.expected_end_time);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    issues.push('невалидна дата/час');
    return issues;
  }
  // Small municipal sites routinely leave old bulletins up on their page for
  // years — confirmed live across several providers (some over a DECADE
  // old). That alone isn't a bug: the parser correctly reads the article's
  // own stated date and status resolves to 'resolved', so it's already
  // invisible to every real user (checkAddressOutageStatus/getLiveMapOutages
  // both filter to expected_end_time > now regardless of the stored status
  // string). Flagging every old page as "suspicious" produced nothing but
  // noise here — the only genuine bug worth surfacing is a record that's
  // clearly in the past yet DIDN'T resolve, i.e. an actual status-computation
  // defect, not just a source site's own stale content.
  const daysPast = (now - start) / (1000 * 3600 * 24);
  if (daysPast > 60 && parsed.status !== 'resolved') {
    issues.push(`началото е преди ${daysPast.toFixed(0)} дни, но статусът НЕ Е "resolved" (status=${parsed.status}) — вероятен бъг`);
  }
  if (end < start) {
    issues.push('крайният час е преди началния');
  }
  return issues;
}

export function getLastSourceAuditReport() {
  return {
    ranAt: lastAuditAt,
    inProgress: auditInProgress,
    ...(lastAuditReport || { total: 0, withIssues: 0, noContentNow: 0, clean: 0, results: [] })
  };
}

export async function runSourceContentAudit() {
  if (auditInProgress) {
    return getLastSourceAuditReport();
  }
  auditInProgress = true;
  const results = [];

  try {
    for (const target of PROVIDER_TARGETS) {
      const entry = {
        provider: target.provider,
        city: target.city,
        url: target.url,
        status: 'ok',
        itemsFound: 0,
        issues: []
      };

      try {
        const items = await scrapeProviderTargetItems(target, { force: true });
        entry.itemsFound = items.length;

        if (items.length === 0) {
          entry.status = 'none'; // Nothing right now — informational, not automatically a bug.
        } else {
          const now = new Date();
          for (const item of items.slice(0, 3)) {
            const parsed = parseOutageTextHeuristic(item.text, target.provider, target.city, item.sourceUrl);
            const dateIssues = checkDateSanity(parsed, now);
            if (dateIssues.length > 0) {
              entry.issues.push({
                problem: dateIssues.join('; '),
                sample: item.text.substring(0, 150)
              });
            }
          }
          entry.sample = items[0].text.substring(0, 150);
        }
      } catch (err) {
        entry.status = 'error';
        entry.issues.push({ problem: 'Грешка при извличане: ' + err.message });
      }

      results.push(entry);
    }
  } finally {
    auditInProgress = false;
  }

  lastAuditReport = {
    total: results.length,
    withIssues: results.filter((r) => r.issues.length > 0).length,
    noContentNow: results.filter((r) => r.status === 'none').length,
    fetchErrors: results.filter((r) => r.status === 'error').length,
    clean: results.filter((r) => r.status === 'ok' && r.issues.length === 0).length,
    results
  };
  lastAuditAt = new Date().toISOString();

  return getLastSourceAuditReport();
}
