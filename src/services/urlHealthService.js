import axios from 'axios';

/**
 * Every official provider URL the app links to or scrapes, kept here as a single
 * source of truth so the health checker and the reader both see the same list.
 * Update this list whenever resolveExactOfficialSourceUrl() or PROVIDER_TARGETS
 * gains/loses a hardcoded domain.
 */
export const PROVIDER_URLS = [
  { name: 'Електрохолд (ЕРМ Запад — Sofia/Blagoevgrad/Pernik/Vratsa scraper source)', url: 'https://ermzapad.bg/bg/za-klienta/prekusvania/' },
  { name: 'Енерго-Про (ЕРП Север)', url: 'https://erpsever.bg/bg/prekysvanija' },
  { name: 'Софийска вода (GIS)', url: 'https://gispx.sofiyskavoda.bg/WebApp.InfoCenter/' },
  { name: 'Софийска вода (HTML fallback)', url: 'https://www.sofiyskavoda.bg' },
  { name: 'Балкангаз 2000', url: 'https://balkangaz2000.com/' },
  { name: 'Костинбродгаз', url: 'https://kostinbrodgaz.bg/' },
  { name: 'Топлофикация Бургас', url: 'https://toplo-bs.com/' },
  { name: 'Топлофикация Перник', url: 'https://toplo-pernik.com/' },
  { name: 'Топлофикация Плевен', url: 'https://toplo-pleven.com/' },
  { name: 'Топлофикация Русе', url: 'https://toplo-ruse.com/' },
  { name: 'Топлофикация София', url: 'https://toplo.bg/accidents-and-maintenance' },
  { name: 'ВиК Бургас', url: 'https://vik-burgas.com/current-repairments/Rajon-Burgas/' },
  { name: 'ВиК Габрово', url: 'https://vik-gabrovo.com/' },
  { name: 'ВиК Габрово (scraper source)', url: 'https://vik-gabrovo.com/avarii-i-remonti' },
  { name: 'ВиК Перник', url: 'https://vik-pernik.eu/' },
  { name: 'ВиК Перник (scraper source)', url: 'https://vik-pernik.eu/repairs/' },
  { name: 'ВиК Плевен', url: 'https://vik-pleven.com/' },
  { name: 'ВиК Русе', url: 'https://vik-ruse.com/' },
  { name: 'ВиК Враца', url: 'https://vik-vratza.eu/info?info=ViKavarii' },
  { name: 'ВиК Пловдив', url: 'https://vik.bg/avarii/' },
  { name: 'ВиК Сливен', url: 'https://vik.sliven.net/' },
  { name: 'ВиК Благоевград', url: 'http://vikblg.com/' },
  { name: 'ВиК Добрич', url: 'https://vikdobrich.bg/Info/BreakdownIndex' },
  { name: 'ВиК Хасково', url: 'https://vikhaskovo.bg/' },
  { name: 'ВиК Пазарджик', url: 'https://vikpz.com/%D0%B0%D0%B2%D0%B0%D1%80%D0%B8%D0%B8/' },
  { name: 'ВиК Варна', url: 'https://vikvarna.com/bg/messages/breakdown.html' },
  { name: 'Аресгаз', url: 'https://www.aresgas.bg/infocenter/' },
  { name: 'EVN (Customers)', url: 'https://www.elyug.bg/Customers/Planned_shutdowns.aspx' },
  { name: 'EVN Бургас', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung1.asp' },
  { name: 'EVN Кърджали', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung2.asp' },
  { name: 'EVN Пазарджик', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung3.asp' },
  { name: 'EVN Пловдив', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung4.asp' },
  { name: 'EVN Сливен', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung5.asp' },
  { name: 'EVN Смолян', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung6.asp' },
  { name: 'EVN Стара Загора', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung7.asp' },
  { name: 'EVN Хасково', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung8.asp' },
  { name: 'EVN Ямбол', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung9.asp' },
  { name: 'EVN Топлофикация', url: 'https://www.evn.bg/Toplo/Outages' },
  { name: 'Овергаз Мрежи', url: 'https://www.overgas.bg/planirani-remonti-i-avarii/' },
  { name: 'ВиК Шумен', url: 'https://www.vik-shumen.net' },
  { name: 'ВиК Йовковци (Велико Търново)', url: 'https://www.vik-vt.com' },
  { name: 'ВиК Стара Загора', url: 'https://www.wik-stz.com/' },
  { name: 'ВиК Видин', url: 'https://vik-vidin.com/' },
  { name: 'Кюстендилска вода', url: 'https://kyustendilskavoda.com/' },
  { name: 'ВиК Монтана', url: 'https://vikmontana.com/bg/messages.html' },
  { name: 'ВиК Ловеч', url: 'https://www.wss-lovech.bg/' },
  { name: 'Водоснабдяване-Дунав (Разград)', url: 'http://dunav-rz.com/' },
  { name: 'ВиК Силистра', url: 'https://vik-silistra.com/водопроводна-авария/' },
  { name: 'ВиК Смолян', url: 'https://www.vik-smolyan.com/' },
  { name: 'ВиК Ямбол', url: 'https://vik-yambol.bg/d0-b0-d0-b2-d0-b0-d1-80-d0-b8-d0-b8-d0-b8-d1-80-d0-b5-d0-bc-d0-be-d0-bd-d1-82-d0-b8/' },
  { name: 'ВиК Търговище', url: 'http://viktg.com/' },
  { name: 'ВиК Кърджали', url: 'https://vik-kardzhali.com/avarii-remont/latest' },
  { name: 'ВиК Петрич', url: 'https://vik-petrich.eu/' },
  { name: 'Увекс (ВиК Сандански)', url: 'https://www.uvexbg.com/' },
  { name: 'ВиК Кресна', url: 'https://kresna-bg.com/' },
  { name: 'ВиК Берковица', url: 'https://vik-berkovica.com/' },
  { name: 'ВиК Стенето (Троян)', url: 'https://viktroyan.com/' },
  { name: 'ВиК Панагюрище', url: 'https://vik-pan.com/' },
  { name: 'ВиК Пещера', url: 'https://www.vks-peshtera.com/' },
  { name: 'ВиК Исперих', url: 'https://vikisperih.com/' },
  { name: 'Инфрастрой (ВиК Брацигово)', url: 'https://infrastroi-eood.com/' },
  { name: 'ВиК София област', url: 'https://viksofbg.com/avarii/' },
  { name: 'Топлофикация Сливен', url: 'https://toplo.sliven.net/' },
  { name: 'Топлофикация Габрово', url: 'https://www.toplo-gb.com/' },
  { name: 'Топлофикация Враца', url: 'https://toplo-vr.com/' },
  { name: 'Топлофикация Велико Търново', url: 'https://www.toplo-vt.com/' },
  { name: 'Севлиевогаз-2000', url: 'https://sevlievogas.eu/' },
  { name: 'Черноморска газова компания', url: 'https://www.bsgc.bg/' },
  { name: 'Кнежа газ', url: 'https://knezha-gaz.com/' },
  { name: 'Правецгаз 1', url: 'https://www.pravecgas1.com/' },
  { name: 'Газинженеринг', url: 'https://gasengeneering.bg/' },
  { name: 'Каварна газ', url: 'http://kavarnagas.my.contact.bg/' },
  { name: 'Газо-Енергийно Дружество Елин Пелин', url: 'https://gas-elinpelin.eu/' },
  { name: 'ЕСП Златни пясъци', url: 'https://esp-zlatni.bg/' },
  { name: 'Примагаз', url: 'https://primagas-bg.com/' },
  { name: 'Ситигаз България', url: 'https://xn--80afnba6ci.xn--90ae/' },
  { name: 'Камено-газ', url: 'http://kameno-gaz.com/' },
  { name: 'Комекес', url: 'https://www.komekes.com/' },
  { name: 'Газтрейд Сливен', url: 'https://gastrade-sliven.com/' },
  { name: 'Свиленград-газ', url: 'http://www.svilengradgaz.com/' },
  { name: 'Веолия Енерджи Варна', url: 'https://energy-varna.bg/' },
  { name: 'Топлофикация Разград', url: 'https://toplo-razgrad.bg/' }
];

const CHECK_TIMEOUT_MS = 8000;
// Was 5 — toplo-bs.com/toplo-vr.com/toplo-ruse.com started showing up as
// "broken" here (403/503) while the real scraper's slower, sequential,
// one-at-a-time PROVIDER_TARGETS loop kept successfully pulling real data
// from the same sites in the same window. A batch of 5 simultaneous
// connections from one IP is a much more bot-like traffic pattern than the
// throttled real scraper ever produces, and is the more likely trigger for
// these sites' WAFs — lowering it, plus a short pause between batches below,
// costs a bit of total check time but shouldn't cost real accuracy: a site
// truly down doesn't start working just because we ask less aggressively.
const CONCURRENCY = 2;
const INTER_BATCH_DELAY_MS = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attemptOnce(entry) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'bg-BG,bg;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://www.google.com/'
  };
  const opts = { timeout: CHECK_TIMEOUT_MS, headers, maxRedirects: 5, validateStatus: () => true };

  // HEAD first — lighter, and some provider sites only misbehave (redirect loops) on GET.
  try {
    const res = await axios.head(entry.url, opts);
    if (res.status >= 200 && res.status < 400) {
      return { ...entry, ok: true, status: res.status, error: null };
    }
  } catch (err) {
    // fall through to GET below — some sites are slow/broken on HEAD specifically
  }

  try {
    const res = await axios.get(entry.url, opts);
    return { ...entry, ok: res.status >= 200 && res.status < 400, status: res.status, error: null };
  } catch (err) {
    return { ...entry, ok: false, status: null, error: err.code || err.message };
  }
}

const RETRY_DELAYS_MS = [1500, 4000];

/**
 * A handful of the simplest, most common ways a provider's URL drifts over
 * time without the page itself actually moving — a site dropping "www.",
 * forcing https, etc. Tried only after the exact URL has failed every
 * retry, so this never masks a real break, only autocorrects the mechanical
 * cases nobody needs a human to diagnose.
 */
function urlVariations(originalUrl) {
  const variants = new Set();
  try {
    const u = new URL(originalUrl);
    const withWww = u.hostname.startsWith('www.') ? null : `www.${u.hostname}`;
    const withoutWww = u.hostname.startsWith('www.') ? u.hostname.slice(4) : null;

    for (const protocol of ['https:', 'http:']) {
      for (const hostname of [u.hostname, withWww, withoutWww].filter(Boolean)) {
        const variant = new URL(originalUrl);
        variant.protocol = protocol;
        variant.hostname = hostname;
        const variantStr = variant.toString();
        if (variantStr !== originalUrl) variants.add(variantStr);
      }
    }
  } catch (e) {
    // Malformed URL — nothing to vary, let the normal broken-link path handle it.
  }
  return [...variants];
}

/**
 * A single slow/timed-out/TLS-hiccup request doesn't mean a site is actually
 * down — several provider sites here are behind WAFs or CDNs that occasionally
 * rate-limit or briefly serve a bad edge node. Retry up to twice, with a longer
 * gap on the second attempt, before reporting broken — confirmed repeatedly
 * that domains flagged after only one retry (timeouts, TLS errors, 403/503)
 * were fine moments later on a fresh request.
 *
 * If every retry on the exact URL still fails, try the small set of
 * mechanical variations (www/non-www, http/https) before giving up — if one
 * of those works, report it as reachable AND surface the working variant so
 * it's obvious in the admin panel that the stored URL should be updated to
 * it, without anyone needing to investigate from scratch.
 */
async function checkOne(entry) {
  let result = await attemptOnce(entry);
  for (const delay of RETRY_DELAYS_MS) {
    if (result.ok) return result;
    await sleep(delay);
    result = await attemptOnce(entry);
  }

  for (const variantUrl of urlVariations(entry.url)) {
    const variantResult = await attemptOnce({ ...entry, url: variantUrl });
    if (variantResult.ok) {
      return { ...result, ok: true, status: variantResult.status, error: null, workingVariant: variantUrl };
    }
  }

  return result;
}

// Consecutive-failure counter per URL, kept across separate calls to
// runUrlHealthCheck() (startup, daily cron, manual button — each is a check
// spread out over real time, not just the in-call retries above). A single
// blip resets to green on the next check; only a genuinely persistent problem
// survives two checks in a row.
const consecutiveFailures = new Map();
const CONFIRM_THRESHOLD = 2;

/**
 * Checks every provider URL for reachability. Never modifies anything —
 * purely reports which official links/scrape targets are broken, so a human
 * can decide on and apply the actual fix (see aiParserService.js
 * resolveExactOfficialSourceUrl and scraperService.js PROVIDER_TARGETS).
 *
 * A URL only shows up as "broken" once it has failed this check AND the
 * previous one — cloud hosting shares IPs that get transiently rate-limited
 * by some providers' WAFs, and a report that cries wolf on every momentary
 * blip just trains you to stop trusting it. Confirmed broken links surface
 * on their own without needing a person to re-run anything.
 */
export async function runUrlHealthCheck() {
  const results = [];
  for (let i = 0; i < PROVIDER_URLS.length; i += CONCURRENCY) {
    const batch = PROVIDER_URLS.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(checkOne));
    results.push(...batchResults);
    if (i + CONCURRENCY < PROVIDER_URLS.length) await sleep(INTER_BATCH_DELAY_MS);
  }

  for (const r of results) {
    const prev = consecutiveFailures.get(r.url) || 0;
    consecutiveFailures.set(r.url, r.ok ? 0 : prev + 1);
  }

  const annotated = results.map((r) => ({ ...r, consecutive_failures: consecutiveFailures.get(r.url) || 0 }));
  const brokenThisCheck = annotated.filter((r) => !r.ok);
  const confirmedBroken = annotated.filter((r) => (consecutiveFailures.get(r.url) || 0) >= CONFIRM_THRESHOLD);
  const drifted = annotated.filter((r) => r.ok && r.workingVariant);

  const report = {
    checked_at: new Date().toISOString(),
    total: annotated.length,
    broken_count: confirmedBroken.length,
    broken: confirmedBroken,
    flaky_this_check: brokenThisCheck.filter((r) => !confirmedBroken.includes(r)),
    // Not broken — reachable, but only via a slightly different URL (http vs
    // https, www vs non-www) than the one hardcoded in the code. The site
    // still works for users right now, but the code should be updated to
    // the working variant next time someone's making changes anyway.
    drifted,
    results: annotated
  };

  console.log(`\n🔗 [URL HEALTH CHECK] ${report.checked_at}`);
  if (drifted.length > 0) {
    console.log(`↪️ ${drifted.length} URL(s) only reachable via a slightly different address — code should be updated when convenient:`);
    drifted.forEach((d) => console.log(`   ~ ${d.name}: ${d.url} -> works as ${d.workingVariant}`));
  }
  if (confirmedBroken.length === 0 && brokenThisCheck.length === 0) {
    console.log(`✅ All ${report.total} provider URLs are reachable.`);
  } else {
    if (confirmedBroken.length > 0) {
      console.warn(`⚠️ ${confirmedBroken.length} of ${report.total} provider URLs failed 2+ checks in a row — likely need a manual fix:`);
      confirmedBroken.forEach((b) => console.warn(`   ✗ ${b.name}: ${b.url} (${b.status || b.error})`));
    }
    if (report.flaky_this_check.length > 0) {
      console.log(`ℹ️ ${report.flaky_this_check.length} URL(s) failed just this once (likely transient) — not yet flagging:`);
      report.flaky_this_check.forEach((b) => console.log(`   ~ ${b.name}: ${b.url} (${b.status || b.error})`));
    }
  }

  lastReport = report;
  return report;
}

let lastReport = null;
export function getLastUrlHealthReport() {
  return lastReport;
}
