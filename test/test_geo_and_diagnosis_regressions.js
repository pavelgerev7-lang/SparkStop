// Regression tests for three real problems found on 2026-09-24 while looking
// at the yellow (amber) providers in the admin scraper-health panel. Same
// approach as test_parser_regressions.js: each case uses the ACTUAL text/data
// that exposed the bug. No network; the geocoding checks only read the static
// settlement registry (importing the geocoding service also loads the cached
// coordinates, exactly like the parser tests already do).
import { cityMentionIndex, parseOutageTextHeuristic, sourceMarksCompleted, sanitizeAffectedStreet, validateAndSanitizeParsedOutage, normalizeOutageLabels, hasExplicitTimeInText, extractDailyWindows, getDailyScheduleInfo, parseBulgarianDateTime, extractStreetsHeuristic } from '../src/services/aiParserService.js';
import { mergeAffectedStreets, selectVanishedRows, describeDailySchedule, namesSettlement, streetContextCities, ZONE_CENTRE_PROVIDERS, sofiaDistrictCentre, buildSofiaHeatingPins, upsertOutage, dedupeStreetPins } from '../src/services/outageService.js';
import { isOnlyPossibleDisruption, cleanOutageAnnouncementText, isAnnouncementIndicatingNoOutage } from '../src/utils/textCleaner.js';
import { getSettlementCoordinates, resolveExactCoordinates, maxStreetDistanceKm, expandAbbreviatedSettlementName, rememberSettlementPoint, formatSettlementLabel } from '../src/services/geocodingService.js';
import { BULGARIAN_SETTLEMENTS, searchMunicipalities, getMunicipalitiesByProvince } from '../src/utils/bulgarianSettlements.js';
import { getStreetSuggestions, getStreetCoordinates } from '../src/services/autocompleteService.js';
import { ownValue } from '../src/utils/ownValue.js';
import { hasMajorStreet, snapToMajorStreet, curatedStreetPoint } from '../src/utils/majorStreets.js';
import { diagnoseEmptyPage, pageSnippet } from '../src/utils/pageDiagnosis.js';
import { parseRetryAfterMs, previewManualAnnouncement, listManualAnnouncementProviders, scrapeProviderTargetItems, PROVIDER_TARGETS, relabelEvnSettlement, humanizeCapsEntry, sofiaZoneEntries, splitRegionItems, registrySettlement, DANGLING_END_RE, isFollowableArticleLink } from '../src/services/scraperService.js';
import http from 'http';
import { buildMassEvent, MASS_REGRESSION_THRESHOLD } from '../src/services/scraperHealthService.js';
import { configureEgress, resetEgress } from '../src/utils/egress.js';

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    failed++;
  }
}

console.log('====================================================');
console.log('🧪 GEOCODING / CITY / PAGE-DIAGNOSIS REGRESSION TESTS');
console.log('====================================================\n');

// ---------------------------------------------------------------------
// Bug 20: "гр.Велинград" written with no space after the dot was never
// recognized as a city marker, so a Велинград outage published on ВиК
// Пазарджик's page stayed filed under the scraper's default city (Пазарджик).
// ---------------------------------------------------------------------
console.log('🔹 20. "гр.Град" (no space after the dot) is recognized as the outage city');
{
  const velingrad = parseOutageTextHeuristic('Прекъснато водоснабдяване: 24 септември 2026 Прекъснато водоснабдяване Поради авария на уличен водопровод на ул.“Еленка“, на 24.09.2026г. /четвъртък/ ще бъде прекъснато водоподаването в района на ул.“Еленка“, ул.“Баба Тонка“, ул.“Сокол“ в гр.Велинград от 09:30 часа до 13:00 часа.', 'ВиК Пазарджик', 'Пазарджик', 'https://vikpz.com/');
  assert(velingrad.city === 'Велинград', `city is Велинград, not the scraper default, got: "${velingrad.city}"`);
  const spaced = parseOutageTextHeuristic('Поради авария ще бъде прекъснато водоподаването в района на ул.“Сокол“ в гр. Велинград от 09:30 до 13:00 часа.', 'ВиК Пазарджик', 'Пазарджик', '');
  assert(spaced.city === 'Велинград', `the spaced form still works, got: "${spaced.city}"`);
  const plain = parseOutageTextHeuristic('Поради авария ще бъде прекъснато водоподаването на ул.“Генерал Гурко“ от 09:30 до 13:00 часа.', 'ВиК Пазарджик', 'Пазарджик', '');
  assert(plain.city === 'Пазарджик', `no city marker keeps the default, got: "${plain.city}"`);
}

// ---------------------------------------------------------------------
// Bug 21: a street that is not a settlement, in an outage with a region,
// resolved to the AVERAGE POINT OF THE WHOLE PROVINCE (getSettlementCoordinates
// returns that flagged isRegionFallback instead of null, and
// resolveExactCoordinates accepted it as a real point) — measured live: 377
// of 2,026 pins, median 20 km from the outage's own town, and marked "exact".
// ---------------------------------------------------------------------
console.log('\n🔹 21. A street that is not a settlement resolves to its own town, never the province average');
{
  const town = getSettlementCoordinates('Велинград', '', 'Пазарджик');
  const provinceAverage = getSettlementCoordinates('__не съществува__', '', 'Пазарджик');
  assert(provinceAverage && provinceAverage.isRegionFallback === true, 'sanity: an unknown name in a region yields the flagged province average');
  for (const street of ['ул. Еленка', 'ул. Баба Тонка', 'кв. Църква']) {
    const pin = resolveExactCoordinates('Велинград', street, '', 'Пазарджик');
    const offTown = Math.hypot(pin.lat - town.lat, pin.lng - town.lng);
    const isAverage = Math.abs(pin.lat - provinceAverage.lat) < 1e-6 && Math.abs(pin.lng - provinceAverage.lng) < 1e-6;
    assert(!isAverage && offTown < 0.05, `"${street}" is at Велинград (${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}), not the Пазарджик province average`);
  }
  // Regression guard: a street name that IS a real settlement in that region still resolves to that settlement.
  const village = getSettlementCoordinates('Огняново', '', 'Пазарджик');
  if (village && !village.isRegionFallback) {
    const pin = resolveExactCoordinates('Велинград', 'с. Огняново', '', 'Пазарджик');
    assert(Math.abs(pin.lat - village.lat) < 1e-6 && Math.abs(pin.lng - village.lng) < 1e-6, 'a village named as the "street" still gets its own coordinates');
  }
}

// ---------------------------------------------------------------------
// Bug 22: the scraper health panel called healthy pages "blocked". A 127 KB
// Топлофикация Габрово news page was flagged only because its contact form
// loads Google reCAPTCHA; ВиК Велинград's expired domain and ВиК Панагюрище's
// own crashing PHP site were both reported as "blocked" too.
// ---------------------------------------------------------------------
console.log('\n🔹 22. Empty-page diagnosis names the real cause and ignores healthy pages');
{
  const padding = '<p>Топло-ГБ: Новини. При авария 066 80 59 75 от 8:00 до 18:00ч. в работни дни.</p>'.repeat(60);
  const healthy = `<!DOCTYPE html><html><head><title>Топло-ГБ: Новини</title><script src="https://www.google.com/recaptcha/api.js?hl=bg" async defer></script></head><body>${padding}</body></html>`;
  assert(diagnoseEmptyPage({ status: 200, bytes: healthy.length, title: 'Топло-ГБ: Новини', html: healthy }) === null, 'a big normal page that merely loads reCAPTCHA is not "blocked"');

  const parkedHtml = '<!DOCTYPE html><html><head><script>window.onload=function(){window.location.href="/lander"}</script></head></html>';
  const parked = diagnoseEmptyPage({ status: 200, bytes: parkedHtml.length, title: '', html: parkedHtml });
  assert(parked && parked.kind === 'parked', `an expired/parked domain is reported as such, got: ${parked && parked.kind}`);

  const phpHtml = "<br /> <b>Fatal error</b>:  Uncaught TypeError: implode(): Argument #1 ($separator) must be of type string, array given in /home/vikpan/www/root/phplibs/pdo/class.db.php:616 Stack trace: #0 /home/vikpan/www/root/phplibs/pdo/class.db.php(616): implode(Array, ', ') #1 {main} thrown in /home/vikpan/www/root/phplibs/pdo/class.db.php on line 616";
  const php = diagnoseEmptyPage({ status: 200, bytes: phpHtml.length, title: '', html: phpHtml });
  assert(php && php.kind === 'server-error', `the provider's own PHP crash is reported as their server error, got: ${php && php.kind}`);

  const cfHtml = '<html><head><title>Just a moment...</title></head><body><h1>Checking your browser before accessing the site.</h1></body></html>';
  const cf = diagnoseEmptyPage({ status: 200, bytes: cfHtml.length, title: 'Just a moment...', html: cfHtml });
  assert(cf && cf.kind === 'bot-protection', `a challenge page is reported as bot protection, got: ${cf && cf.kind}`);

  const blank = diagnoseEmptyPage({ status: 200, bytes: 300, title: '', html: '<html><body></body></html>' });
  assert(blank && blank.kind === 'tiny', `an almost empty page with no recognizable cause is reported as empty, got: ${blank && blank.kind}`);
}

// ---------------------------------------------------------------------
// Bug 23: Топлофикация Бургас answers our server with HTTP 503,
// "Your access to this site has been limited" and Retry-After: 3600 (one
// hour) — and was asked again after 10-30 minutes. A refusal's Retry-After is
// now honoured.
// ---------------------------------------------------------------------
console.log('\n🔹 23. Retry-After from a refusing server is parsed (seconds or HTTP date)');
{
  assert(parseRetryAfterMs('3600') === 3600000, 'seconds form: "3600" -> one hour');
  const now = Date.parse('2026-09-24T12:00:00Z');
  assert(parseRetryAfterMs('Thu, 24 Sep 2026 13:00:00 GMT', now) === 3600000, 'HTTP-date form one hour ahead -> one hour');
  assert(parseRetryAfterMs('Thu, 24 Sep 2026 11:00:00 GMT', now) === 0, 'a date in the past -> 0 (never negative)');
  assert(parseRetryAfterMs('soon') === 0 && parseRetryAfterMs('') === 0 && parseRetryAfterMs(undefined) === 0, 'garbage/empty/missing -> 0');
}

// ---------------------------------------------------------------------
// Manual entry of a pasted announcement (for providers that refuse our
// server): the input checks all run BEFORE any parsing/database work, so they
// are tested here without AI or DB access. The parsing + "nothing is written"
// behavior was verified separately against real announcement texts.
// ---------------------------------------------------------------------
console.log('\n🔹 24. Manual announcement preview refuses bad input before doing any work');
{
  const providers = listManualAnnouncementProviders();
  assert(providers.some((p) => p.provider === 'Топлофикация Русе') && providers.some((p) => p.provider === 'Топлофикация Бургас'), 'the two providers that refuse our server are selectable');
  assert(!providers.some((p) => p.provider === 'ВиК Велинград'), 'the removed ВиК Велинград source is not offered');

  const long = 'На 30.09.2026 г. от 09:00 до 16:00 часа ще бъде прекъснато топлоподаването в кв. Зорница.';
  const unknown = await previewManualAnnouncement({ provider: 'Несъществуващ', text: long });
  assert(unknown.ok === false && /Непознат доставчик/.test(unknown.message), 'unknown provider is refused');
  const tooShort = await previewManualAnnouncement({ provider: 'Топлофикация Русе', text: 'авария' });
  assert(tooShort.ok === false && /твърде кратък/.test(tooShort.message), 'a too-short text is refused');
  const tooLong = await previewManualAnnouncement({ provider: 'Топлофикация Русе', text: 'а'.repeat(8001) });
  assert(tooLong.ok === false && /твърде дълъг/.test(tooLong.message), 'an over-long text is refused');
  const badLink = await previewManualAnnouncement({ provider: 'Топлофикация Русе', text: long, sourceUrl: 'javascript:alert(1)' });
  assert(badLink.ok === false && /http/.test(badLink.message), 'a non-http(s) link is refused');
  const nav = await previewManualAnnouncement({ provider: 'Топлофикация Русе', text: 'Начало / Аварии / Page 2 Начало Новини Контакти Моля изберете Продукти Услуги' });
  assert(nav.ok === false && /меню/.test(nav.message), 'site navigation text is not accepted as an outage');
}

// ---------------------------------------------------------------------
// Топлофикация Русе / Бургас / Враца are big cities whose sites refuse our
// server: they must be tried again EVERY 5-minute cycle (one request, no
// in-cycle retries, no growing pauses) so they are picked up right after the
// provider lets us in — except that an explicit Retry-After is honoured.
// Every other provider keeps the growing back-off. Tested against a local
// server that refuses every request.
// ---------------------------------------------------------------------
console.log('\n🔹 25. Big-city providers that refuse us are probed every cycle; Retry-After is still honoured');
{
  const byName = (n) => PROVIDER_TARGETS.find((t) => t.provider === n);
  assert(['Топлофикация Русе', 'Топлофикация Бургас', 'Топлофикация Враца'].every((n) => byName(n) && byName(n).probeEveryCycle === true), 'Русе, Бургас and Враца are configured to be probed every cycle');
  assert(byName('ВиК Панагюрище') && !byName('ВиК Панагюрище').probeEveryCycle && !byName('Топлофикация Перник').probeEveryCycle, 'other providers keep the default back-off');

  let hits = 0;
  let respond = (res) => { res.writeHead(403, { 'Content-Type': 'text/html' }); res.end('<html>Just a moment...</html>'); };
  const server = http.createServer((req, res) => { hits++; respond(res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const mk = (name, extra = {}) => ({ provider: name, city: 'Тест', url, selector: 'p', defaultUtility: 'heating', ...extra });
  const quiet = console.warn;
  console.warn = () => {};
  try {
    hits = 0;
    const probe = mk('__probe_every_cycle__', { probeEveryCycle: true });
    for (let i = 0; i < 6; i++) await scrapeProviderTargetItems(probe);
    assert(hits === 6, `a refusing site is asked on all 6 consecutive cycles, one request each (got ${hits})`);

    hits = 0;
    const normal = mk('__normal_backoff__');
    for (let i = 0; i < 5; i++) await scrapeProviderTargetItems(normal);
    assert(hits === 3, `a default provider pauses after 3 refusals — 3 requests over 5 cycles (got ${hits})`);

    hits = 0;
    respond = (res) => { res.writeHead(503, { 'Retry-After': '3600', 'Content-Type': 'text/html' }); res.end('<html>Your access to this site has been limited</html>'); };
    const polite = mk('__probe_retry_after__', { probeEveryCycle: true });
    for (let i = 0; i < 4; i++) await scrapeProviderTargetItems(polite);
    assert(hits === 1, `a "Retry-After: 3600" is honoured even for a probed provider — 1 request over 4 cycles (got ${hits})`);
  } finally {
    console.warn = quiet;
    await new Promise((r) => server.close(r));
  }
}

// ---------------------------------------------------------------------
// ВиК Русе / Йовковци / Плевен (found from map popups, 2026-09-24):
//  - "с. Мусина.Извиняваме" — a sentence end glued to the next sentence became
//    a second village; "град Плевен Аварийно" — a title word ran into the name.
//  - a bare village ("Просена") was shown as "ул. Просена".
//  - "Възможни са нарушения във водоподаването" (only POSSIBLE) was treated as a
//    definite planned outage.
//  - a repair the site marks "завършен" before its end time must be closed
//    within one scrape (this only worked in the heuristic parser, not the AI one).
// ---------------------------------------------------------------------
console.log('\n🔹 26. Glued sentence words / bare villages / "possible" wording / completed status');
{
  const musina = parseOutageTextHeuristic('Авариен ремонт с. Мусина (24.09.2026): във връзка с авариен ремонт на водопроводната мрежа, днес 24.09.2026 г. (Четвъртък) от 17:00ч. до 12:00 ч. на 25.09.2026г. (Петък) ще бъде спряно водоподаването за с. Мусина.Извиняваме се за възникналите неудобства. При възможност водоподаването ще бъде възстановено по-рано.', 'ВиК Йовковци', 'Велико Търново', '');
  assert(JSON.stringify(musina.affected_streets) === '["с. Мусина"]', `no second "Мусина.Извиняваме" entry, got: ${JSON.stringify(musina.affected_streets)}`);

  const pleven = parseOutageTextHeuristic('Аварийно прекъсване на водоподаването: Водоснабдяване и Канализация ЕООД, град Плевен Аварийно прекъсване на водоподаването септември 22, 2026 Любомир Димов При извършване на СМР е възникнала авария. За времето от 14:00 до 18:30 ч. ще бъде нарушено водоподаването в ниската зона и централната част на града.', 'ВиК Плевен', 'Плевен', '');
  assert(!pleven.affected_streets.some((s) => /Аварийно/i.test(s)), `"Аварийно" is no longer part of the area name, got: ${JSON.stringify(pleven.affected_streets)}`);

  const prosena = parseOutageTextHeuristic('(25.09 09:00 - 25.09 12:00): 25.09 09:00 - 25.09 12:00 Просена, профилактика на електрозахранването Профилактика на електрозахранването Възможни са нарушения във водоподаването поради профилактика на енергопреносната мрежа', 'ВиК Русе', 'Русе', 'https://vik-ruse.com');
  assert(prosena.city === 'Просена' && JSON.stringify(prosena.affected_streets) === '["с. Просена"]', `a bare village is typed "с. Просена", not left to be shown as a street, got: ${JSON.stringify(prosena.affected_streets)}`);

  assert(isOnlyPossibleDisruption('Профилактика на електрозахранването Възможни са нарушения във водоподаването поради профилактика на енергопреносната мрежа') === true, '"Възможни са нарушения във водоподаването" is a POSSIBLE disruption');
  assert(isOnlyPossibleDisruption('Профилактика на електрозахранването Ще бъде прекъснато водоподаването поради профилактика на енергопреносната мрежа') === false, '"Ще бъде прекъснато водоподаването" is definite');

  assert(['Ремонт на водопровод завършен', 'Аварията е отстранена.', 'Отстранена е авария на ул. Х'].every(sourceMarksCompleted), 'items the source marks done are recognized as completed');
  assert(!['Аварията ще бъде отстранена до 18:00 ч.', 'Очаква се да бъде отстранена до вечерта', 'Ремонтът ще бъде напълно приключен утре', 'Отстраняване на авария на ул. Х'].some(sourceMarksCompleted), 'an announcement that the repair WILL be done is not treated as completed');

  assert(sanitizeAffectedStreet('с. Мусина.Извиняваме') === 'с. Мусина' && sanitizeAffectedStreet('град Плевен Аварийно') === 'град Плевен', 'stored garbage labels are cleaned');
  assert(['ул. ген.Гурко', 'ул. Св.Иван Рилски', 'ул. П.Хитов', 'ул. Проф.Иван Гешов', 'А.П.Чехов'].every((s) => sanitizeAffectedStreet(s) === s), 'real dotted street names are left alone');

  assert(JSON.stringify(mergeAffectedStreets(['с. Мусина', 'с. Мусина.Извиняваме'], ['с. Мусина'])) === '["с. Мусина"]', 're-scrape repairs an already-stored garbage label');
  assert(JSON.stringify(mergeAffectedStreets(['Просена'], ['с. Просена'])) === '["с. Просена"]', 'a bare village already stored is replaced by its typed label, not duplicated');
  assert(JSON.stringify(mergeAffectedStreets(['ул. Христо Ботев'], ['бул. Христо Ботев'])) === '["ул. Христо Ботев","бул. Христо Ботев"]', 'ул. and бул. of the same name stay two different streets');
}

// ---------------------------------------------------------------------
// 2026-09-24: 21 providers went to 0 in the same cycle right after a restart
// (the server's outgoing address refused by their hosting) and came back
// together — the health panel showed 21 separate red alarms. Several
// regressions at once are one event.
// ---------------------------------------------------------------------
console.log('\n🔹 27. Many providers regressing together are reported as one event');
{
  const alerts = (n) => Array.from({ length: n }, (_, i) => ({ provider: `Доставчик ${i}` }));
  assert(buildMassEvent(alerts(MASS_REGRESSION_THRESHOLD - 1)) === null, 'a few regressions stay individual alarms');
  const many = buildMassEvent(alerts(21));
  assert(many && many.count === 21, 'a group of 21 is one event');
  assert(buildMassEvent([...alerts(MASS_REGRESSION_THRESHOLD - 1), { provider: 'ВиК Велинград' }]) === null, 'a retired provider does not count towards the group');
}

// ---------------------------------------------------------------------
// The AI parser and the heuristic parser must file a village-only notice under
// the same city. With Gemini answering, a ВиК Русе village item kept "Русе" as
// the city and the bare village as a "street" (shown as "ул. Стамболово", "гр.
// Русе"); when Gemini was unavailable the heuristic gave the village as the
// city — so the same item flipped between two labels from one cycle to the next.
// ---------------------------------------------------------------------
console.log('\n🔹 28. The AI-output sanitizer files village-only notices like the heuristic parser');
{
  const soon = new Date(Date.now() + 5 * 86400000).toISOString();
  const later = new Date(Date.now() + 5.4 * 86400000).toISOString();
  const ai = (over) => ({ utility_type: 'water', provider: 'ВиК Русе', status: 'scheduled', start_time: soon, expected_end_time: later, ...over });
  const village = validateAndSanitizeParsedOutage(ai({ city: 'Русе', affected_streets: ['Стамболово'] }), '(30.09 08:30 - 30.09 16:30): Стамболово, профилактика на електрозахранването', 'ВиК Русе', 'Русе', 'https://vik-ruse.com');
  assert(village.city === 'Стамболово' && JSON.stringify(village.affected_streets) === '["с. Стамболово"]', `AI answer with the default city -> village as city, typed "с.", got: ${village.city} ${JSON.stringify(village.affected_streets)}`);
  const street = validateAndSanitizeParsedOutage(ai({ city: 'Русе', affected_streets: ['ул. Видин 48'] }), '24.09 08:00 - 24.09 15:00 Русе, ул. Видин 48 Ремонт на водопровод', 'ВиК Русе', 'Русе', 'https://vik-ruse.com');
  assert(street.city === 'Русе' && JSON.stringify(street.affected_streets) === '["ул. Видин 48"]', 'a real street stays under the city');
  const glued = validateAndSanitizeParsedOutage(ai({ city: 'Русе', provider: 'ВиК Йовковци', affected_streets: ['с. Мусина.Извиняваме', 'с. Мусина'] }), 'ще бъде спряно водоподаването за с. Мусина.Извиняваме се', 'ВиК Йовковци', 'Русе', '');
  assert(glued.city === 'Мусина' && JSON.stringify(glued.affected_streets) === '["с. Мусина"]', 'glued sentence words are cut and the duplicate merged');
  const early = validateAndSanitizeParsedOutage(ai({ city: 'Русе', affected_streets: ['ул. Видин 48'] }), '(09.09 08:00 - 25.09 16:00): Русе, ул. Видин 48 Ремонт на водопровод завършен', 'ВиК Русе', 'Русе', '');
  assert(early.status === 'resolved', 'AI parser: an item the source marks "завършен" is resolved even though its scheduled end is in the future');
}

// ---------------------------------------------------------------------
// Optional fixed outgoing address (SCRAPER_PROXY_URL): provider fetches go
// through it when set, and a provider that has EXPLICITLY refused us
// (noProxy) is always contacted directly. Tested with a real local proxy.
// ---------------------------------------------------------------------
console.log('\n🔹 32. A "13:00/20:00" slash pair counts as a stated time window');
{
  // ВиК Стара Загора's table has the window alone in its time column ("13:00/20:00"); the popup said
  // "До отстраняване на аварията" although the stored start/end were right.
  assert(hasExplicitTimeInText('ВиК Стара Загора (район Стара Загора) — 24.09.2026 г., 13:00/20:00 ч.: Поради профилактика на ЕВН са възможни смущения във водоподаването') === true, '13:00/20:00 is a stated time window');
  assert(hasExplicitTimeInText('Поради авария на ул. Х ще бъде спряно водоподаването 24.09/25.09') === false, 'a date pair "24.09/25.09" is not mistaken for a time window');
}

console.log('\n🔹 31. Optional proxy for provider requests; providers that refused us never use it');
{
  assert(configureEgress({}).enabled === false && configureEgress({ SCRAPER_PROXY_URL: '   ' }).enabled === false, 'no proxy configured -> nothing changes');
  const warn = console.warn; console.warn = () => {};
  assert(configureEgress({ SCRAPER_PROXY_URL: 'not a url' }).enabled === false, 'an invalid proxy URL is ignored, not fatal');
  console.warn = warn;
  assert(['Топлофикация Русе', 'Топлофикация Бургас', 'Топлофикация Враца'].every((n) => PROVIDER_TARGETS.find((t) => t.provider === n)?.noProxy === true), 'the providers that explicitly refused us are marked noProxy');
  assert(!PROVIDER_TARGETS.find((t) => t.provider === 'ВиК Пазарджик').noProxy, 'ordinary providers are not');

  let targetHits = 0;
  let proxyHits = 0;
  const html = '<html><head><title>Съобщения</title></head><body><article><h2>Авария</h2><p>Поради авария на ул. Сокол в гр. Велинград ще бъде спряно водоподаването от 09:30 до 13:00 часа на 30.09.2026 г.</p></article></body></html>';
  const target = http.createServer((req, res) => { targetHits++; res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
  const proxy = http.createServer((req, res) => {
    proxyHits++;
    const u = new URL(req.url);
    const upstream = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    upstream.end();
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const targetUrl = `http://127.0.0.1:${target.address().port}/`;
  const mk = (name, extra = {}) => ({ provider: name, city: 'Велинград', url: targetUrl, selector: 'article', defaultUtility: 'water', ...extra });
  try {
    const cfg = configureEgress({ SCRAPER_PROXY_URL: `http://127.0.0.1:${proxy.address().port}` });
    assert(cfg.enabled === true, 'proxy configured');
    const viaProxy = await scrapeProviderTargetItems(mk('__egress_normal__'));
    assert(viaProxy.length >= 1 && targetHits === 1 && proxyHits === 1, `an ordinary provider is fetched THROUGH the proxy (items ${viaProxy.length}, target hits ${targetHits}, proxy hits ${proxyHits})`);
    const direct = await scrapeProviderTargetItems(mk('__egress_refused__', { noProxy: true }));
    assert(direct.length >= 1 && targetHits === 2 && proxyHits === 1, `a noProxy provider is fetched DIRECTLY, the proxy is not used (target hits ${targetHits}, proxy hits ${proxyHits})`);
  } finally {
    resetEgress();
    await new Promise((r) => target.close(r));
    await new Promise((r) => proxy.close(r));
  }
}

console.log('\n🔹 30. Rows re-read from the database (already-parsed cache) get the same label cleaning');
{
  // The scraper serves a stored row back as "already parsed" when the raw text is unchanged, so an
  // improved parser never reached it: four ВиК Русе villages kept "ул. Стамболово" / "гр. Русе" for days.
  const legacy = { city: 'Русе', affected_streets: ['Стамболово'], provider: 'ВиК Русе' };
  const fixed = normalizeOutageLabels(legacy, 'Русе');
  assert(fixed.city === 'Стамболово' && JSON.stringify(fixed.affected_streets) === '["с. Стамболово"]', `stored village-only row -> village city, typed street, got: ${fixed.city} ${JSON.stringify(fixed.affected_streets)}`);
  const street = normalizeOutageLabels({ city: 'Русе', affected_streets: ['ул. Видин 48'] }, 'Русе');
  assert(street.city === 'Русе' && JSON.stringify(street.affected_streets) === '["ул. Видин 48"]', 'a stored real street is left alone');
  const garbage = normalizeOutageLabels({ city: 'Мусина', affected_streets: ['с. Мусина', 'с. Мусина.Извиняваме'] }, 'Велико Търново');
  assert(JSON.stringify(garbage.affected_streets) === '["с. Мусина"]', 'stored garbage label is cleaned and merged');
  assert(normalizeOutageLabels(legacy, 'Русе') !== legacy && legacy.city === 'Русе', 'the input object is not mutated');
}

console.log('\n🔹 29. Page snippet for read-back; "са възможни кратковременни прекъсвания" is a possible disruption');
{
  const snippet = pageSnippet('<html><head><title>X</title><style>p{color:red}</style><script>var a=1;</script></head><body><h1>Аварии</h1><p>Няма  текущи   аварии.</p></body></html>');
  assert(snippet === 'X Аварии Няма текущи аварии.', `snippet is the page's visible text only, got: "${snippet}"`);
  assert(pageSnippet('<p>' + 'а'.repeat(500) + '</p>').length === 140, 'snippet is capped');
  assert(isOnlyPossibleDisruption('Поради ремонт на ВЕЦ Девин са възможни кратковременни прекъсвания в посочения период на територията на Община Девин.') === true, 'EVN Девин notice ("са възможни кратковременни прекъсвания") is a possible disruption');
}

// ---------------------------------------------------------------------
// Bug 33-34 (electricity audit, 2026-09-24): ЕРП Север / EVN announcements that
// cut supply only in daily clock windows. Real texts from both feeds.
// ---------------------------------------------------------------------
const ERP_TWO_WINDOWS = 'На 28.09.2026 г. В периода 8:15 ч. до 9:00 ч. и от 15:00 ч. до 16:00 ч. Поради оперативни превключвания на съоръженията за доставка на електроенергия, са възможни смущения в районите на: Град Габрово: ул. Василка Бенева №1';
const ERP_THREE_DAYS = 'От 23.09.2026 г. до 25.09.2026 г. В периода 9:00 ч. до 11:00 ч. и от 15:00 ч. до 17:00 ч. Поради неотложни ремонтни дейности на съоръженията за доставка на електроенергия, ще бъде прекъснато електрозахранването в районите на: с. Долище';
const EVN_TWO_WINDOWS = 'Планирано изключване на електрозахранването в Област Ямбол. Дата: 24.9.2026 до 24.9.2026. Час: 09:00 - 10:00 и 16:00 - 17:00. Адреси: ГР. ЯМБОЛ, КВ. КАРГОН';
const EVN_DAILY_RANGE = 'Планирано изключване на електрозахранването в Област Сливен. Дата: 14.9.2026 до 25.9.2026. Час: 09:00 - 17:00. Адреси: гр. Твърдица, захранвани от ТП-Билка';
const at = (localIso) => new Date(`${localIso}+03:00`);

console.log('\n🔹 33. Several windows on one day: the outage lasts until the LAST window closes');
{
  const w = extractDailyWindows(ERP_TWO_WINDOWS);
  assert(w.length === 2 && w[0].sh === 8 && w[0].sm === 15 && w[1].sh === 15 && w[1].eh === 16, `ЕРП Север "8:15-9:00 и от 15:00-16:00" -> two windows, got ${JSON.stringify(w)}`);
  assert(extractDailyWindows(EVN_TWO_WINDOWS).length === 2, 'EVN "09:00 - 10:00 и 16:00 - 17:00" -> two windows');
  assert(extractDailyWindows('На 29.09.2026 г. В периода 8:00 ч. до 17:00 ч. Поради обслужване, работно време 8:00 - 17:00').length === 1, 'an unrelated range later in the text is not chained as a second window');
  const p = parseBulgarianDateTime(ERP_TWO_WINDOWS);
  assert(p.start_time === '2026-09-28T05:15:00.000Z' && p.expected_end_time === '2026-09-28T13:00:00.000Z', `start = first window (08:15), end = LAST window (16:00 local), got ${p.start_time} .. ${p.expected_end_time}`);
  const single = parseBulgarianDateTime('На 29.09.2026 г. В периода 8:00 ч. до 17:00 ч. Поради обслужване');
  assert(single.start_time === '2026-09-29T05:00:00.000Z' && single.expected_end_time === '2026-09-29T14:00:00.000Z', 'a single window is unchanged');
}

console.log('\n🔹 34. Daily windows: "live" only inside a window, honest text otherwise');
{
  const p = parseBulgarianDateTime(ERP_THREE_DAYS);
  const info = (t) => getDailyScheduleInfo(ERP_THREE_DAYS, p.start_time, p.expected_end_time, at(t));
  assert(info('2026-09-24T10:00:00').in_window === true, '3-day 9-11/15-17 notice: 10:00 on day 2 is inside a window');
  assert(info('2026-09-24T12:30:00').in_window === false && info('2026-09-24T12:30:00').next_window_text === 'днес 15:00', 'between the windows: supply is on, next one "днес 15:00"');
  assert(info('2026-09-24T18:00:00').next_window_text === 'утре 09:00', 'after the last window of a day: next is "утре 09:00"');
  assert(info('2026-09-25T18:00:00').next_window_text === '', 'after the last window of the last day: nothing next');
  assert(info('2026-09-24T10:00:00').windows_text === '09:00–11:00 и 15:00–17:00', 'window text for the popup');
  assert(getDailyScheduleInfo('На 29.09.2026 г. В периода 8:00 ч. до 17:00 ч. Поради обслужване', '2026-09-29T05:00:00.000Z', '2026-09-29T14:00:00.000Z', at('2026-09-29T09:00:00')) === null, 'a plain single window on one day needs no schedule');
  const rusePlain = 'Аварийно ремонтно дейности: 09.09 08:00 - 25.09 16:00 ул. Даскал Драгни';
  const ruse = parseBulgarianDateTime(rusePlain);
  assert(getDailyScheduleInfo(rusePlain, ruse.start_time, ruse.expected_end_time, at('2026-09-20T22:00:00')) === null, 'a continuous multi-day repair (ВиК Русе "09.09 08:00 - 25.09 16:00") is NOT treated as daily windows');
  const evn = parseBulgarianDateTime(EVN_DAILY_RANGE);
  assert(getDailyScheduleInfo(EVN_DAILY_RANGE, evn.start_time, evn.expected_end_time, at('2026-09-24T23:00:00')).in_window === false, 'EVN "Дата: 14.9 до 25.9, Час: 09:00-17:00": 23:00 is outside the daily window');
  assert(getDailyScheduleInfo(EVN_DAILY_RANGE, evn.start_time, evn.expected_end_time, at('2026-09-24T12:00:00')).in_window === true, 'EVN daily window: 12:00 is inside');
  const evnContinuous = 'Планирано изключване на електрозахранването в Област Стара Загора. Дата: 23.9.2026 до 25.9.2026. Час: 15:39 - 13:00. Адреси: СМУЩЕНИЯ ЗА КЛИЕНТИТЕ ОТ МТП-3 С.К.МАРИНОВО';
  const cont = parseBulgarianDateTime(evnContinuous);
  assert(getDailyScheduleInfo(evnContinuous, cont.start_time, cont.expected_end_time, at('2026-09-24T02:00:00')) === null, 'EVN "23.9 до 25.9, Час: 15:39 - 13:00" runs backwards -> one continuous outage, not daily windows');
  const row = { raw_location_text: ERP_THREE_DAYS, start_time: p.start_time, expected_end_time: p.expected_end_time };
  const between = describeDailySchedule(row, at('2026-09-24T12:30:00'), true);
  assert(between.between_windows === true && between.next_window_text === 'днес 15:00' && between.schedule_text === '09:00–11:00 и 15:00–17:00', 'describeDailySchedule flags "between windows" for the map and the address check');
  assert(describeDailySchedule(row, at('2026-09-24T10:00:00'), true).between_windows === false, 'inside a window: not between windows');
  assert(describeDailySchedule(row, at('2026-09-22T12:30:00'), false).between_windows === false, 'not started yet: upcoming, not "between windows"');
}

// ---------------------------------------------------------------------
// Bug 35: rows the source stopped listing (withdrawn / rescheduled / restored)
// stayed live for days. Closed only after two separate missed passes, never for
// a broken page.
// ---------------------------------------------------------------------
console.log('\n🔹 35. Rows the source no longer lists are closed - carefully');
{
  const passStart = Date.parse('2026-09-24T18:00:00Z');
  const fresh = (id) => ({ id, updated_at: new Date(passStart + 30_000).toISOString() });
  const stale = (id) => ({ id, updated_at: new Date(passStart - 3 * 3600_000).toISOString() });
  const misses = new Map();
  const rows = [fresh('a'), fresh('b'), fresh('c'), stale('x')];
  const pass1 = selectVanishedRows(rows, { passStartedAt: passStart, now: passStart, misses });
  assert(pass1.closeIds.length === 0, 'one missed pass closes nothing (a flaky response must not close rows)');
  const tooSoon = selectVanishedRows(rows, { passStartedAt: passStart, now: passStart + 60_000, misses });
  assert(tooSoon.closeIds.length === 0, 'a second pass within minutes (manual re-run) does not count as a second miss');
  const pass2 = selectVanishedRows(rows, { passStartedAt: passStart + 20 * 60_000, now: passStart + 20 * 60_000, misses: new Map([['x', { misses: 1, lastMissAt: passStart }]]) });
  assert(JSON.stringify(pass2.closeIds) === '["x"]', 'missed by two separate passes -> closed; refreshed rows stay');
  const seenAgain = new Map([['x', { misses: 1, lastMissAt: passStart }]]);
  selectVanishedRows([fresh('x')], { passStartedAt: passStart, now: passStart + 20 * 60_000, misses: seenAgain });
  assert(!seenAgain.has('x'), 'a row that reappears in the source starts counting from zero again');
  const many = ['1', '2', '3', '4', '5'].map(stale).concat([fresh('k1'), fresh('k2')]);
  const primed = new Map(['1', '2', '3', '4', '5'].map((id) => [id, { misses: 5, lastMissAt: 0 }]));
  const mass = selectVanishedRows(many, { passStartedAt: passStart, now: passStart, misses: primed });
  assert(mass.closeIds.length === 0 && mass.skippedAsMass === true, '5 of 7 rows vanishing at once is a broken page, not a clean-up: nothing is closed');
  const two = selectVanishedRows([stale('p'), stale('q'), fresh('r'), fresh('s'), fresh('t')], { passStartedAt: passStart, now: passStart, misses: new Map([['p', { misses: 3, lastMissAt: 0 }], ['q', { misses: 3, lastMissAt: 0 }]]) });
  assert(two.closeIds.length === 2, 'a couple of rows vanishing from a large scope is closed normally');
}

// ---------------------------------------------------------------------
// Bug 36: EVN filed every notice under its PROVINCE name (a village outage read
// "гр. Кърджали" in the popup), and one bulletin naming several villages was
// stored under a single city, so residents of the other villages never matched it.
// ---------------------------------------------------------------------
console.log('\n🔹 36. EVN notices get their real settlement; multi-village bulletins reach every named village');
{
  const evnRaw = 'Планирано изключване на електрозахранването в Област Бургас. Дата: 25.9.2026 до 25.9.2026. Час: 09:00 - 16:00. Адреси: С. ЦЕРКОВСКИ';
  const parsedVillage = parseOutageTextHeuristic(evnRaw, 'EVN България', 'Бургас', 'https://www.elyug.bg/');
  const relabeled = relabelEvnSettlement(parsedVillage, 'Бургас');
  assert(relabeled.city === 'Церковски', `village notice -> its own settlement as city, got "${relabeled.city}"`);
  assert(JSON.stringify(relabeled.affected_streets) === '["с. Церковски"]', `capitals cleaned to the registry spelling and type, got ${JSON.stringify(relabeled.affected_streets)}`);
  const streetsOnly = relabelEvnSettlement({ city: 'Бургас', affected_streets: ['ул. ОГОСТА', 'КВ. РУДНИК'] }, 'Бургас');
  assert(streetsOnly.city === 'Бургас' && streetsOnly.affected_streets.length === 2, 'a notice about streets in the province town keeps the province as city');
  const unverifiable = relabelEvnSettlement({ city: 'Несъществуващо', affected_streets: ['с. Несъществуващо'] }, 'Бургас');
  assert(unverifiable.city === 'Бургас', 'a city the registry cannot confirm inside the province falls back to the province, never a garbage label');

  assert(namesSettlement(['с. Богдан', 'с. Опанец', 'с. Драганово'], 'Опанец') === true, 'a bulletin listing "с. Опанец" among its villages names Опанец');
  assert(namesSettlement(['С. ЦЕРКОВСКИ'], 'Церковски') === true, 'capitals do not matter');
  assert(namesSettlement(['ул. Цанко Церковски'], 'Церковски') === false, 'a street named after a person is not the settlement');
  assert(namesSettlement(['с. Опанец'], 'Плевен') === false, 'a different settlement is not named');
}

// ---------------------------------------------------------------------
// Bug 37: the sentence split in cleanOutageAnnouncementText() cut "с. Телериг." into
// "…на: с." + "Телериг." and dropped the 8-character fragment, so the LAST village of
// a ЕРП Север bulletin (names of 7 letters or fewer) was lost — 66 of 415 live
// announcements were affected, some fell back to "Централна градска част".
// ---------------------------------------------------------------------
console.log('\n🔹 37. The last (short-named) village of a bulletin is not lost; EVN capitals are readable');
{
  const erp = (villages) => cleanOutageAnnouncementText(`На 23.09.2026 г. В периода 9:00 ч. до 16:00 ч. Поради неотложни ремонтни дейности на съоръженията за доставка на електроенергия, ще бъде прекъснато електрозахранването в районите на: ${villages}. Публикувано на 23.09.2026 09:35 Проверете за Вашия обект тук`);
  const one = parseOutageTextHeuristic(erp('с. Телериг'), 'Енерго-Про (ЕРП Север)', 'Добрич', '');
  assert(JSON.stringify(one.affected_streets) === '["с. Телериг"]' && one.city === 'Телериг', `single short village kept (was "Централна градска част"), got ${JSON.stringify(one.affected_streets)} / ${one.city}`);
  const two = parseOutageTextHeuristic(erp('с. Наум, с. Климент'), 'Енерго-Про (ЕРП Север)', 'Шумен', '');
  assert(JSON.stringify(two.affected_streets) === '["с. Наум","с. Климент"]', `both villages kept, got ${JSON.stringify(two.affected_streets)}`);
  const street = parseOutageTextHeuristic(erp('гр. Габрово: ул. Липа'), 'Енерго-Про (ЕРП Север)', 'Габрово', '');
  assert(street.affected_streets.some((s) => /Липа/.test(s)), `a short street name at the end of the list is kept, got ${JSON.stringify(street.affected_streets)}`);
  const initials = parseOutageTextHeuristic(erp('гр. Търговище: ул. Н. Вапцаров'), 'Енерго-Про (ЕРП Север)', 'Търговище', '');
  assert(initials.affected_streets.some((s) => /Н\. Вапцаров/.test(s)), `a street keeps its initial ("ул. Н. Вапцаров"), got ${JSON.stringify(initials.affected_streets)}`);
  const cleaned = cleanOutageAnnouncementText('Ремонт на ул. Иван Вазов. Работата ще приключи в 17:00 ч. Моля за извинение.');
  assert(cleaned.includes('Работата ще приключи') && cleaned.includes('ул. Иван Вазов'), 'ordinary sentence ends are still split as before');

  assert(humanizeCapsEntry('УЛ. ВАСИЛ ЛЕВСКИ') === 'ул. Васил Левски', `"УЛ. ВАСИЛ ЛЕВСКИ" -> "${humanizeCapsEntry('УЛ. ВАСИЛ ЛЕВСКИ')}"`);
  assert(humanizeCapsEntry('С. ЦЕРКОВСКИ') === 'с. Церковски', 'village in capitals');
  assert(humanizeCapsEntry('ул. СТАМБОЛИЙСКИ') === 'ул. Стамболийски', 'lower-case prefix, capital name');
  assert(humanizeCapsEntry('ГР.БЕЛОВО') === 'гр. Белово', 'no space after the dot');
  assert(humanizeCapsEntry('УЛ. Г.ДИМИТРОВ') === 'ул. Г.Димитров', 'initial before the dot');
  assert(humanizeCapsEntry('КВ. ТП-6 ИЗТОК') === 'кв. ТП-6 Изток', 'technical abbreviations stay in capitals');
  assert(humanizeCapsEntry('ул. Васил Левски') === 'ул. Васил Левски' && humanizeCapsEntry('с. Брош') === 'с. Брош', 'mixed-case entries are untouched');
  assert(humanizeCapsEntry('СЕЛО ДОБРОСЕЛЕЦ') === 'село Доброселец', `"СЕЛО ДОБРОСЕЛЕЦ" -> "${humanizeCapsEntry('СЕЛО ДОБРОСЕЛЕЦ')}"`);
  const dash = relabelEvnSettlement({ city: 'Бургас', affected_streets: ['гр. Китен - изключване', 'с. Люляк - без захранване'] }, 'Бургас');
  assert(dash.affected_streets[0] === 'гр. Китен' && /Люляк$/.test(dash.affected_streets[1]), `"гр. Китен - изключване" -> "гр. Китен", got ${JSON.stringify(dash.affected_streets)}`);
  const supplied = extractStreetsHeuristic('Дата: 25.9.2026. Час: 09:00 - 16:30. Адреси: част от гр. Стралджа захранени от ТП Васил Левски');
  assert(supplied.some((s) => s === 'гр. Стралджа'), `"гр. Стралджа захранени" -> "гр. Стралджа", got ${JSON.stringify(supplied)}`);
}

// ---------------------------------------------------------------------
// Bug 38: a ЕРП Север bulletin naming a town AND a village was filed under the
// village with the town named nowhere; villages listed as "селата : A , B , C" (type
// given once) were not extracted at all.
// ---------------------------------------------------------------------
console.log('\n🔹 38. Town + village in one bulletin; "селата : A , B , C"');
{
  const ERP = 'Енерго-Про (ЕРП Север)';
  const mixed = 'На 28.09.2026 г. В периода 8:30 ч. до 16:30 ч. Поради профилактика на съоръженията за доставка на електроенергия, са възможни смущения в районите на: гр. Русе: МТП Т - 2 Капаклийка; с. Пиргово: Т 1, Т 2, „ТКЗС Т-2“, МТП „Складова база“; Фирми и обекти: „Крис Груп“ ЕООД, Кметство с. Пиргово.';
  const p = parseOutageTextHeuristic(mixed, ERP, 'Русе', '');
  assert(p.city === 'Русе' && p.affected_streets.includes('с. Пиргово'), `a bulletin naming the region's own town stays under that town, the village keeps its own entry, got ${p.city} ${JSON.stringify(p.affected_streets)}`);
  const villageFirst = parseOutageTextHeuristic(mixed.replace('гр. Русе: МТП Т - 2 Капаклийка; ', ''), ERP, 'Русе', '');
  assert(villageFirst.city === 'Пиргово', `a village-only bulletin is still filed under its village, got ${villageFirst.city}`);
  const otherTown = parseOutageTextHeuristic('На 28.09.2026 г. В периода 8:30 ч. до 16:30 ч. Поради ремонт, ще бъде прекъснато електрозахранването в районите на: гр. Борово: ул. Дунав; с. Баниска.', ERP, 'Русе', '');
  assert(otherTown.city === 'Борово' && otherTown.affected_streets.includes('с. Баниска'), `another town of the region is the city, its village stays listed, got ${otherTown.city} ${JSON.stringify(otherTown.affected_streets)}`);
  assert(!parseOutageTextHeuristic(mixed, 'Софийска вода', 'Русе', '').affected_streets.includes('гр. Русе'), 'other providers are unchanged (their footers name the company town)');
  const own = parseOutageTextHeuristic('На 25.09.2026 г. В периода 9:00 ч. до 16:00 ч. Поради ремонт, ще бъде прекъснато електрозахранването в районите на: гр. Варна: ул. Найден Геров, ул. Драва.', ERP, 'Варна', '');
  assert(own.city === 'Варна' && !own.affected_streets.some((s) => /^гр\./.test(s)), `the town that IS the row's city is still not repeated, got ${own.city} ${JSON.stringify(own.affected_streets)}`);
  const list = parseOutageTextHeuristic('На 29.09.2026 г. В периода 8:00 ч. до 17:00 ч. Поради профилактика, ще бъде прекъснато електрозахранването в районите на: гр. Габрово фирмите: „НИКИ 21“ ЕООД, Детска градина село Враниловци, - селата : Враниловци , Стоевци , Михайловци , Райновци,. Проверете за Вашия обект тук', ERP, 'Габрово', '');
  const names = list.affected_streets.join('|');
  assert(['Стоевци', 'Михайловци', 'Райновци'].every((v) => names.includes(`с. ${v}`)), `villages of "селата : …" extracted, got ${JSON.stringify(list.affected_streets)}`);
  assert(list.affected_streets.filter((s) => /Враниловци/.test(s)).length === 1, 'a village named twice is listed once');
  assert(!list.affected_streets.some((s) => /фирмите/i.test(s)), 'no glued "фирмите" in the town entry');

  const road = 'На 29.09.2026 г. В периода 8:00 ч. до 10:00 ч. Поради ремонти, са възможни смущения в районите на: гр. Шумен - фирма "Брадърс комерс", военното поделение на изхода от гр. Шумен за гр. Варна, Асфалтова база.';
  const shumen = parseOutageTextHeuristic(road, ERP, 'Шумен', '');
  assert(shumen.city === 'Шумен', `a Шумен outage naming the road to Варна is filed under Шумен, got "${shumen.city}"`);
  assert(shumen.affected_streets.every((s) => s === s.trim()) && shumen.affected_streets.filter((s) => s === 'гр. Шумен').length === 1, `no "гр. Шумен " twin with a trailing space, got ${JSON.stringify(shumen.affected_streets)}`);
  assert(parseOutageTextHeuristic(road, 'ВиК Шумен', 'Шумен', '').city === 'Варна', 'other providers keep the registry-order behaviour (unchanged)');
}

// ---------------------------------------------------------------------
// Bug 39 (map pins): streets of a town+villages bulletin were all looked up in ONE
// city, so the town's streets landed at a village's pin (and the reverse); a cached
// same-named street 12 km / 213 km away was shown as an "exact" pin.
// ---------------------------------------------------------------------
console.log('\n🔹 39. Each street is pinned in ITS settlement; implausibly distant geocodes are ignored');
{
  const ctx = streetContextCities('Габрово', ['кв. Войново', 'ул. Шенини', 'с. Враниловци', 'ул. Първа', 'гр. Габрово', 'ул. Радецки'], 'Габрово');
  assert(JSON.stringify(ctx) === JSON.stringify(['Габрово', 'Габрово', 'Враниловци', 'Враниловци', 'Габрово', 'Габрово']), `streets take the settlement named before them, got ${JSON.stringify(ctx)}`);
  assert(JSON.stringify(streetContextCities('Габрово', ['с. Несъществуващо', 'ул. Х'], 'Габрово')) === JSON.stringify(['Габрово', 'Габрово']), 'a settlement the registry cannot confirm does not become a context');
  assert(JSON.stringify(streetContextCities('Русе', [], 'Русе')) === '[]', 'empty list');
  const gabrovo = getSettlementCoordinates('Габрово', '', 'Габрово');
  const vil = getSettlementCoordinates('Враниловци', '', 'Габрово');
  assert(maxStreetDistanceKm('софия', null) === 15 && maxStreetDistanceKm('бургас', null) === 10, 'big towns allow a wide radius');
  assert(maxStreetDistanceKm('габрово', gabrovo) === 6.5 && maxStreetDistanceKm('враниловци', vil) === 3.5, 'a town 6.5 km, a village 3.5 km');
  const glued = extractStreetsHeuristic('Адреси: с. Минерални бани.ул.Акация, ул. Детелина');
  assert(glued.includes('с. Минерални бани') && glued.some((s) => /Акация/.test(s)), `"бани.ул.Акация" is split into the village and its street, got ${JSON.stringify(glued)}`);
}

// ---------------------------------------------------------------------
// Bug 40 (water audit): real texts from ВиК Пазарджик / Веолия / Добрич / Хасково / Габрово /
// Враца / Петрич that were mis-read.
// ---------------------------------------------------------------------
console.log('\n🔹 40. Water: multi-day dates are not clock times, spaced dates, footers, plural lists, testimonials');
{
  const local = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Europe/Sofia' }).slice(0, 16);
  const velingrad = 'Прекъснато водоснабдяване: 23 септември 2026 Прекъснато водоснабдяване Във връзка с изпълнение на обект: Основен ремонт и реконструкция на част от водопроводната мрежа по улици: ул. „Елин връх”, ул.“ген.Гурко“ в гр. Велинград от фирма “ ЕКОДИН“ ЕООД от 24.09.2026 год. (четвъртък) до 01.10.2026г. (четвъртък) ще бъде прекъсвано водоподаването за… 23 септември 2026';
  const v = parseBulgarianDateTime(velingrad);
  assert(local(v.start_time).startsWith('2026-09-24') && local(v.expected_end_time).startsWith('2026-10-01'), `"от 24.09.2026 год. (четвъртък) до 01.10.2026г." runs 24.09 -> 01.10 (was 25.09 00:09 -> 01:10), got ${local(v.start_time)} .. ${local(v.expected_end_time)}`);
  assert(hasExplicitTimeInText('ще бъде прекъсвано водоподаването от 24.09.2026 г. до 01.10.2026 г.') === false, 'two dates alone are not a stated clock time');
  assert(hasExplicitTimeInText('без вода от 9:00 до 17:00 ч.') === true, 'a real clock range still is');

  const veolia = 'Годишна профилактика: В периода от 04:00 ч. на 05.10.2026 (понеделник) до 24:00 ч. на 09.10.2026 г. (петък), „Веолия Енерджи Варна“ ЕАД ще извърши планови ремонтни дейности';
  const vo = parseBulgarianDateTime(veolia);
  assert(local(vo.start_time) === '2026-10-05 04:00' && local(vo.expected_end_time) === '2026-10-10 00:00', `"от 04:00 ч. на 05.10 до 24:00 ч. на 09.10" is one continuous outage to 09.10 24:00, got ${local(vo.start_time)} .. ${local(vo.expected_end_time)}`);
  const dt = parseBulgarianDateTime('Спиране от 24.09.2026 10:00 до 25.09.2026 12:00 в с. Х');
  assert(local(dt.start_time) === '2026-09-24 10:00' && local(dt.expected_end_time) === '2026-09-25 12:00', `date+time on both ends, got ${local(dt.start_time)} .. ${local(dt.expected_end_time)}`);
  const ruse = parseBulgarianDateTime('(09.09 08:00 - 25.09 16:00): 09.09 08:00 - 25.09 16:00 Русе, ул. "Даскал Драгни" № 2 - № 5 Ремонт на водопровод');
  assert(local(ruse.expected_end_time).includes('-09-25 16:00'), `the yearless ВиК Русе range still works, got ${local(ruse.expected_end_time)}`);

  const dobrich = cleanOutageAnnouncementText('- Район Добрич-селска: с. Дебрене ще бъде без водоподаване до 23. 09. 2026г.; с. Смолница; с. Крагулево');
  assert(dobrich.includes('23. 09. 2026'), `the spaced date survives the sentence splitter, got: ${dobrich}`);
  const dt2 = parseBulgarianDateTime(dobrich);
  assert(local(dt2.expected_end_time).startsWith('2026-09-23') && !local(dt2.start_time).includes('19:00'), `and parses as the date 23.09, not "until 23:00" (was 19:00-23:00 today), got ${local(dt2.start_time)} .. ${local(dt2.expected_end_time)}`);
  assert(hasExplicitTimeInText(dobrich) === false, '"до 23. 09. 2026г." is not a stated clock time');

  const haskovo = 'ВиК Хасково: Екипи на ВиК отстраняват авария по главен водопровод за Хасково. С нарушено водоподаване са абонатите в кварталите "Република", части от "Възраждане", части от " Тракийски" и " Овчарски". Очаква се водоподаването да бъде възстановено до края на деня. ЕИК: 126004284 И№ ДДС: BG126004284 гр. Хасково, ул. „Сакар“ №2, ПК 6300';
  const hk = parseOutageTextHeuristic(cleanOutageAnnouncementText(haskovo), 'ВиК Хасково', 'Хасково', '');
  assert(['Република', 'Възраждане', 'Тракийски', 'Овчарски'].every((q) => hk.affected_streets.includes(`кв. ${q}`)), `"кварталите …" list is extracted, got ${JSON.stringify(hk.affected_streets)}`);
  assert(!hk.affected_streets.some((s) => /Сакар|ите$/.test(s)), 'no company-footer street and no "квартал ите"');

  const gabrovo = 'Без вода в четвъртък - 24.09.2026 - район Габрово: За извършване на аварийни ремонти без вода от 9:00 до 17:00 ч. ще останат селата Драгановци, Лесичарка и Стоевци. "Черни връх" и село Враниловци ще са с нарушено водоподаване. Габрово, бул. “Трети март” № 6, Денонощен телефон за аварии: 066 816 130 Този сайт използва бисквитки';
  const gb = parseOutageTextHeuristic(cleanOutageAnnouncementText(gabrovo), 'ВиК Габрово', 'Габрово', '');
  assert(['Драгановци', 'Лесичарка', 'Стоевци'].every((q) => gb.affected_streets.includes(`с. ${q}`)), `"селата A, B и C." — all three villages, got ${JSON.stringify(gb.affected_streets)}`);
  assert(!gb.affected_streets.some((s) => /Трети март/.test(s)), 'the company address in the footer is not an affected street');

  const vratsa = '„Водоснабдяване и канализация“ ООД, гр. Враца: "Водоснабдяване и канализация“ ООД – Враца уведомява своите потребители, че поради авария, ще бъде спряно водоподаването в гр. Мизия и с. Софрониево в интервала от 22:30 часа на 24.09.2026г. до 08:30 часа на 25.09.2026г.';
  const vr = parseOutageTextHeuristic(vratsa, 'ВиК Враца', 'Враца', '');
  assert(vr.affected_streets.includes('с. Софрониево') && vr.affected_streets.includes('гр. Мизия') && !vr.affected_streets.includes('гр. Враца'), `the second town is kept, the company's home town is not, got ${JSON.stringify(vr.affected_streets)}`);

  assert(isAnnouncementIndicatingNoOutage('Анастасия Петкова: Отзиви Какво клиентите казват за нас Доволна съм от обслужването! Водопроводчиците бяха изключително вежливи. Отстраниха теч след ремонт на водомер') === true, 'a customer testimonial is not an outage');
  assert(isAnnouncementIndicatingNoOutage('Поради авария на ул. „Иван Вазов“ ще бъде спряно водоподаването от 9:00 до 17:00 ч.') === false, 'a real outage is still one');
}

// ---------------------------------------------------------------------
// Bug 41 (Sofia water): the zone sentence was ONE "street", pinned at the city centre.
// ---------------------------------------------------------------------
console.log('\n🔹 41. Софийска вода zones: real entries, pinned at the polygon centre');
{
  const vladaya = sofiaZoneEntries('зона за спиране- с. Владая- района заключен между ЖП линия „София-Перник“, ул.„Лесковец“, ул.“Войнишко въстание“ ,ул.“Любомир Миланов“,ул. „Акад. П. Стайнов“, ул.“Равнище“ и в.з. Приплат');
  assert(vladaya[0] === 'с. Владая' && vladaya.includes('ул. Лесковец') && vladaya.includes('ул. Равнище') && !vladaya.some((s) => /района|заключен/.test(s)), `Владая zone -> village + its streets, got ${JSON.stringify(vladaya)}`);
  assert(JSON.stringify(sofiaZoneEntries('Зона на спиране:в.з.Килиите')) === '["в.з. Килиите"]', 'a "в.з." zone keeps its name');
  const pirin = sofiaZoneEntries('Зона на спиране:с. Световрачене- ул. Железопътна от ул. Синчец до ул. Пирин. ул Пирин от ул. Софийска до ул. Железопътна');
  assert(pirin.filter((s) => /Пирин/.test(s)).length === 1, `"ул Пирин" and "ул. Пирин" are one entry, got ${JSON.stringify(pirin)}`);
  assert(ZONE_CENTRE_PROVIDERS.has('Софийска вода') && !ZONE_CENTRE_PROVIDERS.has('EVN България'), 'only the polygon-based provider is pinned at its zone centre');
}

// ---------------------------------------------------------------------
// Bug 42 (ВиК Добрич): one province-wide list became one row filed under a single town.
// ---------------------------------------------------------------------
console.log('\n🔹 42. ВиК Добрич: every "Район X" is its own item');
{
  const target = { url: 'https://vikdobrich.bg/Info/BreakdownIndex' };
  const all = '- Район Добрич: м-ст Лозята; Поради авария, ул. Методи Кусевич ще е с нарушено водоподаване; - Район Добрич-селска: с. Дебрене ще бъде без водоподаване до 23. 09. 2026г.; с. Смолница; - Район Балчик: гр. Балчик - ул. П. Яворов, ул. Странджа; - Район Каварна: с. Божурец; С настоящото съобщение, молим жителите да приемат нашите извинения.';
  const items = splitRegionItems([{ text: all, sourceUrl: target.url }, { text: '- Район Добрич-селска: с. Дебрене ще бъде без водоподаване до 23. 09. 2026г.; с. Смолница;', sourceUrl: target.url }, { text: 'Друго съобщение без райони', sourceUrl: 'x' }], target);
  assert(items.length === 5, `4 райони (the overlapping copy is dropped) + the untouched item = 5, got ${items.length}`);
  assert(new Set(items.map((i) => i.sourceUrl)).size === 5, 'each район has its own stable key');
  const balchik = items.find((i) => /Балчик/.test(i.text) && /Район Балчик/.test(i.text));
  const parsed = parseOutageTextHeuristic(balchik.text, 'ВиК Добрич', 'Добрич', balchik.sourceUrl);
  assert(parsed.city === 'Балчик' && !parsed.affected_streets.some((s) => /Божурец|Дебрене/.test(s)), `the Балчик район is filed under Балчик and holds only its own streets, got ${parsed.city} ${JSON.stringify(parsed.affected_streets)}`);
  assert(!items.some((i) => /С настоящото съобщение/.test(i.text)), 'the closing courtesy paragraph is not part of any район');
}

// ---------------------------------------------------------------------
// Bug 43 (Топлофикация София): every pin was "unverified" because the district name sat in
// the region column; a bare "Изток" landed 9 km away, block lists on a fixed point in
// Красно село, street groups at the city centre.
// ---------------------------------------------------------------------
console.log('\n🔹 43. Топлофикация София: pins stay inside their district');
{
  const kmBetween = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 111 * Math.cos(a.lat * Math.PI / 180));
  assert(sofiaDistrictCentre('Слатина (Христо Смирненски)') && sofiaDistrictCentre('Младост 1А') && sofiaDistrictCentre('Студентски Град'), 'district names as toplo.bg writes them are known');
  assert(sofiaDistrictCentre('Несъществуващ') === null, 'an unknown district returns null (the generic path applies)');
  const row = { region: 'Изток' };
  const pins = buildSofiaHeatingPins(row, ['Изток', 'бл.85,бл.86,бл.87, ОДЗ №13', 'ул. "Райко Алексиев" бл.бл.93,94,95, ул."Юрий Гагарин" бл.бл.13,14', 'бл.№ 49']);
  const centre = sofiaDistrictCentre('Изток');
  assert(pins.length >= 5, `district + block lists + a street group split into its streets, got ${pins.length} pins`);
  assert(pins.every((p) => kmBetween(p, centre) <= 4.1), `no pin leaves the district (max ${Math.max(...pins.map((p) => kmBetween(p, centre))).toFixed(2)} km)`);
  const district = pins.find((p) => p.street === 'Изток');
  assert(district.geo_precision === 'exact' && kmBetween(district, centre) < 0.01, 'a district entry is pinned at the district centre');
  const blocks = pins.find((p) => /^бл\.85/.test(p.street));
  assert(blocks.geo_precision === 'approximate', 'a block list has no street: district centre, honestly labelled approximate');
  assert(pins.some((p) => /Райко Алексиев/.test(p.street)) && pins.some((p) => /Юрий Гагарин/.test(p.street)), 'the street group is split into its streets');
  assert(buildSofiaHeatingPins({ region: 'Нещо' }, ['ул. X']) === null, 'unknown district -> null');
}

// ---------------------------------------------------------------------
// Bug 44 (final geographic audit): every settlement the live map showed was checked against
// OpenStreetMap — wrong/missing registry entries, provider spellings, cross-province villages,
// glued names, ЕРП capitals, ВиК Хасково's village lists dropped as "no street, no time".
// ---------------------------------------------------------------------
console.log('\n🔹 44. Settlement coordinates and labels verified against OpenStreetMap');
{
  const near = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 111 * Math.cos(a.lat * Math.PI / 180)) < 1;
  assert(near(getSettlementCoordinates('Добротич', '', 'Варна'), { lat: 43.3955, lng: 27.4249 }), 'Добротич (Варна) — registry was 24 km off');
  assert(near(getSettlementCoordinates('Славяново', '', 'Хасково'), { lat: 41.8074, lng: 25.7825 }), 'Славяново (Хасково) — registry was 11 km off');
  assert(near(getSettlementCoordinates('Средище', '', 'Търговище'), { lat: 43.0602, lng: 26.2965 }), 'Средище (Търговище) — was missing');
  assert(getSettlementCoordinates('Ламбриново', '', 'Силистра').name === 'Полковник Ламбриново' && getSettlementCoordinates('Иширково', '', 'Силистра').name === 'Професор Иширково' && getSettlementCoordinates('Васил Друмево', '', 'Шумен').name === 'Васил Друмев', 'provider spellings resolve to the registry names');
  const dobroselec = getSettlementCoordinates('Доброселец', '', 'Ямбол');
  assert(dobroselec && !dobroselec.isRegionFallback && dobroselec.region === 'Хасково', `EVN's Ямбол page lists Доброселец (Тополовград, Хасково province): found there, got ${dobroselec && dobroselec.region}`);
  const tsalapitsa = getSettlementCoordinates('Цалапица', '', 'Пазарджик');
  assert(tsalapitsa && !tsalapitsa.isRegionFallback && tsalapitsa.region === 'Пловдив', 'Цалапица listed under Пазарджик is the one in Пловдив province');
  const doiranci = getSettlementCoordinates('Дойранци', '', 'Пловдив');
  assert(!doiranci || doiranci.isRegionFallback === true, 'a same-named village 300 km away is still never taken');

  assert(registrySettlement('Добрич- улици', 'Добрич').name === 'Добрич' && registrySettlement('Каварна по', 'Добрич').name === 'Каварна' && registrySettlement('Добрич ИДИС АД', 'Добрич').name === 'Добрич', 'glued words after a settlement name are ignored');
  assert(registrySettlement('Несъществуващо село', 'Добрич') === null, 'an unknown name stays unknown');

  const erp = relabelEvnSettlement({ city: 'ЦАРЕВА ЛИВАДА', affected_streets: ['с. ЦАРЕВА ЛИВАДА', 'ул. ХРИСТО БОТЕВ'] }, 'Габрово', { provinceFallback: false });
  assert(erp.city === 'Царева ливада' && erp.affected_streets[0] === 'с. Царева ливада' && erp.affected_streets[1] === 'ул. Христо Ботев', `ЕРП capitals made readable, registry spelling, got ${JSON.stringify(erp)}`);
  const unknown = relabelEvnSettlement({ city: 'ЖЪЛЪД', affected_streets: ['с. ЖЪЛЪД'] }, 'Шумен', { provinceFallback: false });
  assert(unknown.city === 'Жълъд', `a village the registry does not know keeps its name (not the province), got ${unknown.city}`);
  const devin = relabelEvnSettlement({ city: 'Смолян', affected_streets: ['Поради ремонт на ВЕЦ Девин са възможни кратковременни прекъсвания в посочения период на територията на Община Девин.'] }, 'Смолян');
  assert(devin.affected_streets[0] === 'гр. Девин', `a municipality-wide sentence becomes its seat, got ${JSON.stringify(devin.affected_streets)}`);
  assert(relabelEvnSettlement({ city: 'Стара Загора', affected_streets: ['кв. Самара-БКТП Дедов'] }, 'Стара Загора').affected_streets[0] === 'кв. Самара', 'the substation is not part of the quarter name');
  assert(!parseOutageTextHeuristic('На 28.09.2026 г. В периода 9:00 ч. до 12:00 ч. Поради профилактика, ще бъде прекъснато електрозахранването в районите на: гр. Добрич ЕЛЕКТРОРАЗПРЕДЕЛЕНИЕ СЕВЕР АД, ЕЛИЗ АД, част бул."ТРЕТИ МАРТ".', 'Енерго-Про (ЕРП Север)', 'Добрич', '').affected_streets.some((s) => /ЕЛЕКТРОРАЗПРЕДЕЛЕНИЕ/.test(s)), "the utility's own building is not an affected address");

  const lines = ['Поради авария на напорен водопровод с нарушено водоподаване са селата Щит, Пашово, Сладун.', 'Две аварии се отстраняват днес и по водопровод към Пъстрогор, това е причината за нарушено водоподаване в селата Изворово Браница Черепово, за тях е осигурена мобилна водоноска.'];
  assert(lines.every((l) => isAnnouncementIndicatingNoOutage(l) === false), 'ВиК Хасково\'s "…са селата Щит, Пашово, Сладун" lines are outages (were dropped as "no street, no time")');
  assert(JSON.stringify(parseOutageTextHeuristic(lines[0], 'ВиК Хасково', 'Хасково', '').affected_streets) === '["с. Щит","с. Пашово","с. Сладун"]', 'the three villages are extracted');
  assert(['Изворово', 'Браница', 'Черепово'].every((v) => parseOutageTextHeuristic(lines[1], 'ВиК Хасково', 'Хасково', '').affected_streets.includes(`с. ${v}`)), 'villages without separators are split');
  assert(isAnnouncementIndicatingNoOutage('Електропроводът е собственост на Лукойл и не захранва клиенти на ЕР Юг') === true, 'a line that supplies no customers is not an outage');
  assert(isAnnouncementIndicatingNoOutage('Няма аварии. Нормално водоподаване в селата.') === true, 'a real "no outages" line is still dropped');
}

// ---------------------------------------------------------------------
// Bug 45 (last audit before the store release): two insert/resolve loops (the integrity sweep
// resolved rows the scrapers kept re-creating), provider regions that are not provinces,
// abbreviated village names, dash-glued notice words, corrupted registry entries.
// ---------------------------------------------------------------------
console.log('\n🔹 45. No insert/resolve loops; regions, abbreviations and labels');
{
  const near1 = (a, b) => !!a && Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 111 * Math.cos(a.lat * Math.PI / 180)) < 1;
  // The door and the sweep use one predicate.
  const lukoil = await upsertOutage({ utility_type: 'electricity', provider: 'EVN България', city: 'Пазарджик', region: 'Пазарджик', raw_location_text: 'Планирано изключване на електрозахранването в Област Пазарджик. Дата: 5.10.2026 до 5.10.2026. Час: 13:00 - 17:00. Адреси: Електропроводът е собственост на Лукойл и не захранва клиенти на ЕР Юг', affected_streets: ['Електропроводът е собственост на Лукойл и не захранва клиенти на ЕР Юг'], status: 'scheduled', start_time: new Date(Date.now() + 86400000).toISOString(), expected_end_time: new Date(Date.now() + 90000000).toISOString() });
  assert(lukoil && lukoil.skipped === 'not an outage announcement' && lukoil.id === null, 'an announcement the sweep would resolve is not inserted at all');
  const shabla = '- Район Шабла: гр. Шабла - напор за къмпинг "Добруджа", без водоподаване рибарско селище "Кария", къмпинг "Добруджа" и военно поделение до приключване на аварията.';
  assert(isAnnouncementIndicatingNoOutage(shabla) === false, 'a real open-ended ВиК Добрич line that names only "гр. Шабла" is an outage');
  const province = '- Район Добрич: Ул. Ивайло - квартала срещу автогарата; - Район Каварна: гр. Каварна - ул. "Ал. Стамболийски" - ниска зона с нарушено водоподаване - Район Шабла: гр. Шабла - напор за къмпинг "Добруджа" до приключване на аварията. - Район Тервел: с. Зърнево';
  const parts = splitRegionItems([{ text: province, sourceUrl: 'https://vikdobrich.bg/Info/BreakdownIndex' }], { url: 'https://vikdobrich.bg/Info/BreakdownIndex' });
  assert(parts.length === 4 && parts.every((p) => isAnnouncementIndicatingNoOutage(p.text) === false), `each район line of the province list passes the same filter the sweep applies, got ${parts.length}`);

  // Provider "regions" that are not provinces.
  const reg = (n, r) => getSettlementCoordinates(n, '', r);
  assert(reg('Петрич', 'Петрич').region === 'Благоевград' && reg('Дрангово', 'Петрич').region === 'Благоевград', 'region "Петрич" (ВиК Петрич) is the Благоевград province');
  assert(reg('Берковица', 'Берковица').region === 'Монтана', 'region "Берковица" is the Монтана province');
  assert(!reg('Ботевград', 'София-област').isRegionFallback && !reg('Литаково', 'София-област').isRegionFallback, 'region "София-област" finds the Sofia-province villages the registry files under "София-град"');
  assert(near1(reg('Гургулят', 'София-област'), { lat: 42.7913, lng: 22.9757 }), 'Гургулят (община Сливница) — was missing');
  assert(near1(reg('Янкула', 'Габрово'), { lat: 42.8510, lng: 25.2577 }) && near1(reg('Слънчев бряг', 'Бургас'), { lat: 42.6939, lng: 27.7105 }), 'Янкула and the Слънчев бряг resort — verified against OSM');
  assert(reg('Чукили', 'Габрово').name === 'Чукилите' && reg('Врабци', 'Габрово').name === 'Врабците' && reg('Ясени', 'Габрово').name === 'Ясените' && reg('Хаджийска', 'Велико Търново').name === 'Горна Хаджийска' && reg('Вичево', 'Добрич').name === 'Вичово', 'spellings the providers use resolve to the registry names');
  assert(registrySettlement('Слънчев Бряг Общежитие Лале', 'Бургас').name === 'Слънчев бряг', 'an EVN site glued to the resort name resolves to the resort');

  // Abbreviated first word.
  assert(reg('Г. Кабда', 'Търговище').name === 'Горна Кабда' && reg('М.Чинка', 'Кърджали').name === 'Малка Чинка' && reg('Г. Тошево', 'Добрич').name === 'Генерал Тошево', '"Г. Кабда", "М.Чинка", "Г. Тошево" resolve to the registry names');
  assert(expandAbbreviatedSettlementName('Г. Оряховица') === 'Горна Оряховица' && expandAbbreviatedSettlementName('Д. Митрополия') === 'Долна Митрополия', 'well-known two-word towns');
  assert(expandAbbreviatedSettlementName('Г. Несъществуващо') === null, 'unknown abbreviations are not guessed');
  assert(sanitizeAffectedStreet('с. Г. Кабда') === 'с. Горна Кабда' && sanitizeAffectedStreet('гр. Г. Тошево - целия град') === 'гр. Генерал Тошево', 'stored labels are expanded and cut');
  const kabda = parseOutageTextHeuristic('На 29.09.2026 г. В периода 9:00 ч. до 16:00 ч. ще бъде прекъснато електрозахранването в районите на: с. Лиляк, с. Пресиян, с. Г. Кабда, с. Цветница. Проверете за Вашия обект тук', 'Енерго-Про (ЕРП Север)', 'Търговище', '');
  assert(kabda.affected_streets.includes('с. Горна Кабда') && kabda.raw_location_text.includes('с. Г. Кабда'), 'the parsed list is spelled out while the stored source text stays as published');
  const toshevo = parseOutageTextHeuristic('- Район Г. Тошево: гр. Г. Тошево - целия град с нарушено водоподаване поради авария; с. Вичево; с. Изворово; с. Спасово', 'ВиК Добрич', 'Добрич', '');
  assert(toshevo.city === 'Генерал Тошево' && JSON.stringify(toshevo.affected_streets) === '["с. Вичево","с. Изворово","с. Спасово"]', `the район's own town is the city, got ${toshevo.city} ${JSON.stringify(toshevo.affected_streets)}`);

  // Notice words glued to a place by a dash / a courtesy line.
  assert(JSON.stringify(parseOutageTextHeuristic('- Район Балчик: с. Гурково - 2 аварии', 'ВиК Добрич', 'Добрич', '').affected_streets) === '["с. Гурково"]', '"с. Гурково - 2 аварии" is the village Гурково');
  assert(JSON.stringify(parseOutageTextHeuristic(shabla, 'ВиК Добрич', 'Добрич', '').affected_streets) === '["гр. Шабла"]', '"гр. Шабла - напор за къмпинг…" is the town Шабла');
  assert(!parseOutageTextHeuristic('ВиК Силистра ЕООД, гр. Силистра поднася извиненията си за неудобствата от 08:00 ч. до 16:00 ч. на 30.09.2026', 'ВиК Силистра', 'Силистра', '').affected_streets.some((s) => /извинени/i.test(s)), 'the courtesy line is not part of the town name');
  assert(JSON.stringify(sofiaZoneEntries('зона на спиране -с.Мировяне -ул.Мировско шосе от ул.Тополите до ул.Радецки')) === '["с. Мировяне","ул. Мировско шосе","ул. Тополите","ул. Радецки"]', 'a village and a street glued by a dash are two entries');
  assert(JSON.stringify(sofiaZoneEntries('ж.к. Люлин - 5')) === '["ж.к. Люлин - 5"]', 'a quarter keeps its number after the dash');
  const shumen = parseOutageTextHeuristic('На 29.09.2026 г. В периода 8:00 ч. до 10:00 ч. са възможни смущения в районите на: гр. Шумен - фирма "Брадърс комерс", военното поделение на изхода от гр. Шумен за гр. Варна, Асфалтова база. Проверете за Вашия обект тук', 'Енерго-Про (ЕРП Север)', 'Шумен', '');
  assert(!shumen.affected_streets.includes('гр. Варна') && shumen.affected_streets.includes('гр. Шумен'), 'a town named as a road direction ("за гр. Варна") is not an affected place');
  assert(parseOutageTextHeuristic('Спиране на водата за гр. Пловдив от 08:00 до 16:00 ч. на 27.09.2026', 'ВиК Пловдив', 'Пловдив', '').affected_streets.includes('гр. Пловдив'), '"за гр. Пловдив" without an earlier town is still a target');

  const gabrovo = parseOutageTextHeuristic('На 01.10.2026 г. В периода 8:00 ч. до 13:00 ч. Поради профилактика ще бъде прекъснато електрозахранването в районите на: гр. Габрово - квартал „Войнoво“ , квартал „Шенини“, ул. „Шенини“ и ул. „Стрежерът” , фирмите: „ДИМАНА“ ООД, кв. ”Войново”, „ТИРИМИ ЕООД”. Проверете за Вашия обект тук', 'Енерго-Про (ЕРП Север)', 'Габрово', '');
  assert(gabrovo.affected_streets.filter((s) => /Войново/.test(s)).length === 1 && gabrovo.affected_streets.includes('квартал Шенини'), `a quarter with a Latin look-alike letter is the same quarter as the correctly typed one, got ${JSON.stringify(gabrovo.affected_streets)}`);
  const evnCaps = parseOutageTextHeuristic('Планирано изключване на електрозахранването в Област Бургас. Дата: 29.9.2026 до 29.9.2026. Час: 08:30 - 16:30. Адреси: Поради планови дейности без захранване ще бъдат клиентите от индустриалната зона на кв. Долно Езерово, както и част от абонатите от ул. Лом. # ГР. БУРГАС - КВ.ДОЛНО ЕЗЕРОВО западна индустр.зона', 'EVN България', 'Бургас', '');
  assert(!evnCaps.affected_streets.some((s) => /западна/.test(s)), `EVN's capitals followed by ordinary words: the words are not part of the name, got ${JSON.stringify(evnCaps.affected_streets)}`);
  assert(parseOutageTextHeuristic('Планирано изключване на електрозахранването в Област Русе. Дата: 29.9.2026 до 29.9.2026. Час: 08:30 - 16:30. Адреси: УЛ. ПЕЙО К.ЯВОРОВ, БУЛ. ЦАР БОРИС III ОБЕДИНИТЕЛ', 'EVN България', 'Русе', '').affected_streets.length === 2, 'all-capital EVN streets are untouched');

  // 68 villages whose registry position was wrong by 2.5-118 km, each confirmed against OpenStreetMap
  // (a same-named node inside the same municipality).
  assert(near1(reg('Коньовец', 'Шумен'), { lat: 43.3646, lng: 26.9899 }) && near1(reg('Божурка', 'Търговище'), { lat: 43.1838, lng: 26.4478 }) && near1(reg('Каблешково', 'Добрич'), { lat: 43.7501, lng: 27.3083 }) && near1(reg('Кардам', 'Добрич'), { lat: 43.7546, lng: 28.1057 }) && near1(reg('Буйновица', 'Шумен'), { lat: 43.5914, lng: 26.9461 }), 'Коньовец, Божурка, Каблешково, Кардам, Буйновица sit where OpenStreetMap has them');

  const stale = resolveExactCoordinates('Славяново', 'ул. Христо Ботев', '', 'Търговище');
  assert(!(Math.abs(stale.lat - 43.2667) < 1e-6 && Math.abs(stale.lng - 26.1833) < 1e-6), 'a street cached at the OLD wrong village centre is not trusted as a real position');

  // The registry itself.
  assert(BULGARIAN_SETTLEMENTS.every((s) => ![s.name, s.region, s.municipality].some((v) => /�/.test(String(v || '')))), 'no corrupted (U+FFFD) name/region/municipality left in the settlement registry');
  assert(reg('Чернокапци', 'Търговище').name === 'Чернокапци' && reg('Миролюбово', 'Бургас').region === 'Бургас' && reg('Чокоба', 'Сливен').region === 'Сливен', 'the seven repaired entries are found in their provinces');
}

// ---------------------------------------------------------------------
// Bug 46: the pin of a big boulevard must lie ON the boulevard (Русе бул. България was pinned 2.6 km past
// its end, бул. Васил Левски ~1 km beside it, Добрич бул. Добруджа 300 m beside it, кв. Възраждане 1 km south).
// ---------------------------------------------------------------------
console.log('\n🔹 46. Boulevard pins lie on the boulevard (real OpenStreetMap geometry)');
{
  const dist = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 111 * Math.cos(a.lat * Math.PI / 180));
  assert(hasMajorStreet('русе', 'бул. България') && hasMajorStreet('добрич', 'бул. Добруджа') && hasMajorStreet('русе', 'бул. Васил Левски') && hasMajorStreet('велико търново', 'бул. България') === hasMajorStreet('велико търново', 'бул. България'), 'the boulevards are in the geometry data');
  const onEnd = snapToMajorStreet('русе', 'бул. България', { lat: 43.8744, lng: 26.0493 });
  assert(dist(onEnd, { lat: 43.8755, lng: 26.0165 }) < 0.4, `Русе бул. България: the pin 2.6 km past the end lands on the end at the Danube Bridge, got ${onEnd.lat},${onEnd.lng}`);
  const keep = { lat: 43.83806, lng: 25.96804 };
  assert(snapToMajorStreet('русе', 'бул. България', keep) === keep, 'a point already on the boulevard is not moved');
  const vl = snapToMajorStreet('русе', 'бул. Васил Левски', { lat: 43.8319, lng: 25.9579 });
  assert(dist(vl, { lat: 43.83, lng: 25.9715 }) < 0.8 && dist(vl, { lat: 43.8319, lng: 25.9579 }) > 0.3, `Русе бул. Васил Левски: moved onto the boulevard, got ${vl.lat},${vl.lng}`);
  const db = snapToMajorStreet('добрич', 'бул. Добруджа', { lat: 43.5699, lng: 27.8287 });
  assert(dist(db, { lat: 43.5699, lng: 27.8287 }) < 0.5 && dist(db, { lat: 43.5725, lng: 27.8285 }) < 0.6, `Добрич бул. Добруджа: 300 m beside the road moves onto it, got ${db.lat},${db.lng}`);
  assert(snapToMajorStreet('русе', 'ул. Непозната', { lat: 1, lng: 2 }).lat === 1, 'a street that is not a known boulevard is untouched');
  const bridge = curatedStreetPoint('русе', 'бул. България', 'гр. Русе, Дунав мост, бул. България 123, 125, 133 А, 310');
  assert(bridge && dist(bridge, { lat: 43.8755, lng: 26.0163 }) < 0.3 && curatedStreetPoint('русе', 'бул. България', 'бул. България 12') === null, 'a notice naming the Danube Bridge pins бул. България at the bridge');
  const vaz = resolveExactCoordinates('Русе', 'кв. Възраждане', '', 'Русе');
  assert(dist(vaz, { lat: 43.8571, lng: 25.9673 }) < 0.3, `кв. Възраждане (Русе) is pinned at the suburb, got ${vaz.lat},${vaz.lng}`);
  const road = resolveExactCoordinates('Русе', 'бул. България', '', 'Русе');
  assert(snapToMajorStreet('русе', 'бул. България', road) === road || dist(snapToMajorStreet('русе', 'бул. България', road), road) < 0.01, 'the resolver already returns an on-road point for бул. България');
}

console.log('\n🔹 47. A village the registry lacks is remembered once found in OpenStreetMap');
{
  const before = getSettlementCoordinates('Тестово Несъществуващо', '', 'Габрово');
  assert(before && before.isRegionFallback === true, 'an unknown village first falls back to the province (approximate)');
  rememberSettlementPoint('с. Тестово Несъществуващо', 'Габрово', 42.9, 25.3, { persist: false });
  const after = getSettlementCoordinates('Тестово Несъществуващо', '', 'Габрово');
  assert(after && !after.isRegionFallback && after.lat === 42.9 && after.lng === 25.3 && after.name === 'Тестово Несъществуващо', 'once remembered it resolves to its own point and is no longer "approximate"');
  const other = getSettlementCoordinates('Тестово Несъществуващо', '', 'Ловеч');
  assert(other && other.isRegionFallback === true, 'the memory is per province (a same-named village elsewhere is not affected)');
}

console.log('\n🔹 48. Notices whose place is in the next paragraph, a facility, or a municipality');
{
  assert(DANGLING_END_RE.test('На 28.09.2026г от 10:00ч до 14:00ч ще бъде спряно водоподаването в') && !DANGLING_END_RE.test('ще бъде спряно водоподаването в кв.Долно Езерово.') && !DANGLING_END_RE.test('спряна водата на с, Изворище.'), 'a paragraph ending on a preposition continues in the next element');
  const vb = parseOutageTextHeuristic('На 28.09.2026г от 10:00ч до 14:00ч ще бъде спряно водоподаването в кв.Долно Езерово по улиците "Средногорие" , "Пасат" и "Есперанто". Ще се извършват строително монтажти работи.', 'ВиК Бургас', 'Бургас', '');
  assert(JSON.stringify(vb.affected_streets) === '["кв. Долно Езерово","ул. Средногорие","ул. Пасат","ул. Есперанто"]', `the quarter name stops before "по улиците", got ${JSON.stringify(vb.affected_streets)}`);
  const iz = parseOutageTextHeuristic('На 23.09.2026г / сряда/ от 10:00ч до 12:00ч ще бъде спряна водата на с, Изворище.', 'ВиК Бургас', 'Бургас', '');
  assert(JSON.stringify(iz.affected_streets) === '["с. Изворище"]' && iz.city === 'Изворище', 'a comma typed instead of the dot ("с, Изворище") still names the village');
  const sv = parseOutageTextHeuristic('От 01.10.2026 г. до 02.10.2026 г. В периода 9:00 ч. до 16:30 ч. Поради обезопасяване на съоръженията за доставка на електроенергия, ще бъде прекъснато електрозахранването в районите на: община Свищов част от абонатите на ТП 10 и ТП 11 Алеково. Проверете за Вашия обект тук', 'Енерго-Про (ЕРП Север)', 'Велико Търново', '');
  assert(sv.city === 'Свищов' && sv.affected_streets[0] === 'гр. Свищов', `"община Свищов …" is filed under Свищов, not the region's town, got ${sv.city} ${JSON.stringify(sv.affected_streets)}`);
  const sh = parseOutageTextHeuristic('На 29.09.2026 г. В периода 8:30 ч. до 9:30 ч. Поради неотложни ремонтни дейности, ще бъде прекъснато електрозахранването в районите на: ЕМЗ Шабла. Проверете за Вашия обект тук', 'Енерго-Про (ЕРП Север)', 'Добрич', '');
  assert(sh.city === 'Шабла' && JSON.stringify(sh.affected_streets) === '["гр. Шабла"]', `"ЕМЗ Шабла" is Шабла, got ${sh.city} ${JSON.stringify(sh.affected_streets)}`);
  assert(JSON.stringify(parseOutageTextHeuristic('Годишна профилактика на съоръженията в отоплителната централа и по топлопреносната мрежа. Уважаеми Клиенти, в периода от 04:00 ч. на 05.10.2026 до 24:00 ч. на 09.10.2026 г. Веолия Енерджи Варна ЕАД ще извърши планови ремонтни дейности', 'Веолия Енерджи', 'Варна', '').affected_streets) === '["Централна градска част"]', 'a city-wide notice that names no other place keeps the generic label');
  const dz = parseOutageTextHeuristic('На 29.09.2026 г. В периода 8:30 ч. до 13:00 ч. ще бъде прекъснато електрозахранването в районите на: с. Дончево; СИЛК ГАЗ БГ ЕООД, ЖП Гара с. Дончево, ТД ДЪРЖАВЕН РЕЗЕРВ ВАРНА. Проверете за Вашия обект тук', 'Енерго-Про (ЕРП Север)', 'Добрич', '');
  assert(dz.city === 'Дончево', `"…РЕЗЕРВ ВАРНА" is not "в Варна": the village notice stays under Дончево, got ${dz.city}`);
  const bc = parseOutageTextHeuristic('От 28.09.2026 г. до 02.10.2026 г. В периода 9:00 ч. до 16:00 ч. са възможни смущения в районите на: Община Павликени: гр. Бяла Черква в района на ТП Училище Б.Черква. Проверете за Вашия обект тук', 'Енерго-Про (ЕРП Север)', 'Велико Търново', '');
  assert(bc.city !== 'Бяла' && /Бяла/.test(bc.city), `"гр. Бяла Черква" is not the town "Бяла", got ${bc.city}`);
  assert(cityMentionIndex('гр. бяла черква', 'гр. ', 'бяла') === -1 && cityMentionIndex('гр. бяла, ул. дунав', 'гр. ', 'бяла') === 0 && cityMentionIndex('резерв варна', 'в ', 'варна') === -1 && cityMentionIndex('във варна', 'във ', 'варна') === 0, 'town mentions are whole-word');
}

console.log('\n🔹 49. Electricity-map audit 2026-10-02: quarter vs same-named village, registry beats cached search hits, village labels');
{
  const kmBetween = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 111 * Math.cos(a.lat * Math.PI / 180));
  const belovo = getSettlementCoordinates('Белово', '', 'Пазарджик');
  const kv = resolveExactCoordinates('Белово', 'кв. Марица', '', 'Пазарджик');
  assert(kmBetween(kv, belovo) < 8, `"кв. Марица" of Белово stays at Белово, not at the village Марица (Самоков, 42 km west), got ${JSON.stringify(kv)}`);
  assert(getSettlementCoordinates('кв. Марица', '', 'Пазарджик').isRegionFallback === true, 'a quarter name never borrows a same-named village of a neighbouring province');
  const villageRule = getSettlementCoordinates('с. Марица', '', 'Пазарджик');
  assert(villageRule && !villageRule.isRegionFallback, 'the neighbouring-province rule still serves VILLAGE entries ("с. Марица")');
  const dobrotich = resolveExactCoordinates('Ветрино', 'с. Добротич', '', 'Варна');
  assert(kmBetween(dobrotich, { lat: 43.3955, lng: 27.4249 }) < 0.5, `"с. Добротич" is the registry point (a cached search hit was 23 km off), got ${JSON.stringify(dobrotich)}`);
  const stozher = resolveExactCoordinates('Стожер', 'с. Стожер', '', 'Добрич');
  assert(kmBetween(stozher, { lat: 43.434149, lng: 27.823152 }) < 0.5, `"с. Стожер" is the registry point (a cached search hit was 3 km off), got ${JSON.stringify(stozher)}`);
  assert(formatSettlementLabel('Армени', '', 'Габрово', ['с. Армени']) === 'с. Армени', 'a village missing from the registry takes its type from the bulletin entry ("с. Армени", not "гр. Армени")');
  assert(formatSettlementLabel('Пряспа', '', 'Добрич', ['с. Пряспа', 'ул. Девета']) === 'с. Пряспа', 'same for "с. Пряспа"');
  assert(formatSettlementLabel('Горна Оряховица', '', 'Велико Търново', ['с. Горна Оряховица']) === 'гр. Горна Оряховица', 'a registry town keeps "гр." whatever an entry says');
}

console.log('\n🔹 50. A road-traffic notice about pipe works is not a water outage');
{
  const svishtov = 'Съобщение гр. Свищов (02.10.2026): ВиК Йовковци” ООД, ЕР-Свищов уведомява, че от 05.10.2026г. до 30.10.2026г. във връзка с Авариен ремонт по подмяна на водопроводната мрежа по ул. “Цар Освободител”, гр. Свищов участъкът от кръстовището с ул. “Патриарх Евтимий” (площад „Хан Бъчва“) до кръстовището с ул. „Никола Петков“ (площад „Свобода“) ще бъде ограничено за движение за МПС.Моля да не паркирате МПС в участъка на ремонтните дейности. Извиняваме се за възникналите неудобства.';
  assert(isAnnouncementIndicatingNoOutage(svishtov) === true, 'ВиК Йовковци / Свищов: "ограничено за движение за МПС … да не паркирате" is a traffic notice, not an outage');
  const both = 'На 05.10.2026 г. от 09:00 до 16:00 ч. ще бъде спряно водоподаването в гр. Свищов по ул. „Цар Освободител“ поради авариен ремонт. Движението на МПС в участъка ще бъде ограничено.';
  assert(isAnnouncementIndicatingNoOutage(both) === false, 'a real outage that ALSO restricts traffic stays an outage (the supply is cut)');
  const power = 'На 06.10.2026 г. ще бъде прекъснато електрозахранването в с. Лозен. Моля да не паркирате автомобили под въздушната линия.';
  assert(isAnnouncementIndicatingNoOutage(power) === false, 'a power cut with a parking request stays an outage');
}

console.log('\n🔹 51. The scraper only follows article links on the provider\'s own site');
{
  const page = 'https://www.vik-targovishte.bg/info/avarii';
  assert(isFollowableArticleLink('https://www.vik-targovishte.bg/info/?id=84', page) === true, 'a link on the same host is followed');
  assert(isFollowableArticleLink('/info/?id=84', 'https://vik-targovishte.bg/x') === false, 'a relative link is made absolute BEFORE the check (it has no host of its own here)');
  assert(isFollowableArticleLink('https://vik-targovishte.bg/news/1', page) === true, 'www. is ignored');
  assert(isFollowableArticleLink('https://avarii.wik-stz.com/2015/08/06/x/', 'https://wik-stz.com/') === true, 'a sub-domain of the provider (ВиК Стара Загора\'s outage log) is followed');
  assert(isFollowableArticleLink('https://wik-stz.com/x', 'https://avarii.wik-stz.com/y') === true, 'a parent domain of the provider is followed');
  assert(isFollowableArticleLink('http://10.10.0.7/info/?tid=15&&id=84', page) === false, 'the provider\'s INTERNAL address (ВиК Търговище\'s real links) is not followed');
  assert(isFollowableArticleLink('http://169.254.169.254/latest/meta-data/', page) === false && isFollowableArticleLink('http://localhost:3000/api/admin/stats', page) === false && isFollowableArticleLink('http://[::1]/', page) === false, 'cloud metadata, localhost and loopback are not followed');
  assert(isFollowableArticleLink('https://evil.example/vik-targovishte.bg', page) === false && isFollowableArticleLink('https://vik-targovishte.bg.evil.example/', page) === false, 'another site that merely contains the name is not followed');
  assert(isFollowableArticleLink('https://user:pass@vik-targovishte.bg/x', page) === false, 'credentials in the link are refused');
  assert(isFollowableArticleLink('file:///etc/passwd', page) === false && isFollowableArticleLink('javascript:alert(1)', page) === false && isFollowableArticleLink('not a url', page) === false, 'other schemes and garbage are refused');
  assert(isFollowableArticleLink('https://toplosliven.com/avarii-i-profilaktiki', 'https://toplo.sliven.net/') === false, 'a link to the provider\'s OTHER domain is refused by default');
  const sliven = PROVIDER_TARGETS.find((t) => t.provider === 'Топлофикация Сливен');
  assert(sliven && isFollowableArticleLink('https://toplosliven.com/avarii-i-profilaktiki', sliven.url, sliven.followHosts) === true, 'Топлофикация Сливен lists its other domain as a reviewed exception and is followed there');
  assert(sliven && isFollowableArticleLink('http://10.10.0.7/x', sliven.url, sliven.followHosts) === false, 'the exception covers only that host');
}

console.log('\n🔹 52. "constructor" / "__proto__" as a place name is a miss, not a crash');
{
  assert(ownValue({ a: 1 }, 'a') === 1 && ownValue({ a: 1 }, 'constructor') === undefined && ownValue({ a: 1 }, '__proto__') === undefined && ownValue({ a: 1 }, 'toString') === undefined, 'ownValue returns only what the table itself holds');
  assert(ownValue(null, 'a') === undefined, 'ownValue tolerates a missing table');
  for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    let threw = null;
    try {
      const s = await getStreetSuggestions(word, 'ab');
      const m = searchMunicipalities('a', word);
      const p = getMunicipalitiesByProvince(word);
      const c = getStreetCoordinates(word, 'ул. Иван Вазов');
      const r = await resolveExactCoordinates(word, word, word, word);
      if (!Array.isArray(s) || !Array.isArray(m) || !Array.isArray(p) || (c !== null && typeof c !== 'object') || (r !== null && typeof r !== 'object')) threw = 'unexpected result type';
    } catch (e) { threw = e.message; }
    assert(threw === null, `"${word}" as city / province / region does not throw (${threw || 'ok'})`);
  }
}

console.log('\n🔹 53. The same street twice in one outage is one marker');
{
  const a = { street: 'с. Алеково', lat: 43.5, lng: 25.1, precise: true, geo_precision: 'exact' };
  const twice = dedupeStreetPins([a, { ...a }]);
  assert(twice.length === 1 && twice[0] === a, 'two identical pins collapse into the first one');
  const other = dedupeStreetPins([a, { ...a, lat: 43.6 }, { ...a, street: 'с. Друго' }]);
  assert(other.length === 3, 'the same street at ANOTHER point, and another street at the same point, are both kept');
  assert(dedupeStreetPins([{ ...a, street: 'ул. Чехов' }, { ...a, street: ' УЛ. ЧЕХОВ ' }]).length === 1, 'case and spaces do not make a street different');
  assert(dedupeStreetPins(null).length === 0 && dedupeStreetPins([]).length === 0, 'nothing in, nothing out');
  const line = { ...a, line: [[1, 2], [3, 4]] };
  assert(dedupeStreetPins([line])[0].line.length === 2, 'a pin keeps its start/end line');
}

console.log('\n🔹 54. A transformer substation named like a place is not an affected place');
{
  const trg = 'На 07.10.2026 г. В периода 9:30 ч. до 16:00 ч. Поради неотложни ремонтни дейности на съоръженията за доставка на електроенергия, ще бъде прекъснато електрозахранването в районите на: част от гр. Търговище, захранена от ТП "Квартал 301", кв. "Запад" №1, 2, 3, 4, 5, 6, 8, 9, 10, 31, 36. Проверете за Вашия обект тук';
  const s1 = extractStreetsHeuristic(trg, 'Търговище');
  assert(!s1.some((s) => /301/.test(s)) && s1.includes('кв. Запад'), 'ТП "Квартал 301" is not listed as quarter 301; the real кв. Запад is kept');
  const s2 = extractStreetsHeuristic('ще бъде прекъснато електрозахранването в районите на: ул. "Иван Вазов", с. Лозен, ТП "ул. Дунав" и кв. Изток', 'София');
  assert(s2.includes('ул. Иван Вазов') && s2.includes('с. Лозен') && s2.includes('кв. Изток') && !s2.some((s) => /Дунав/.test(s)), 'a substation called "ул. Дунав" is skipped, the real places around it are kept');
  const s3 = extractStreetsHeuristic('прекъсване на водата в кв. Тракия и ул. "Пирин". Подстанция ПС Враца няма отношение.', 'Пловдив');
  assert(s3.includes('кв. Тракия') && s3.includes('ул. Пирин'), 'ordinary notices are unaffected');
}

console.log('\n🔹 55. A long free-text "Адреси:" is cut at a word, not in the middle of one');
{
  const sz = 'Планирано изключване на електрозахранването в Област Стара Загора. Дата: 1.10.2026 до 5.10.2026. Час: 09:00 - 17:00. Адреси: Временно преустановяване на ел. захранването поради планов ремонт на въздушна линия средно напрежение от 01.10.2026г. до 05.10.2026г. (през работни дни) от 09:00 часа до 17:00 часа - клиенти захранени от ТП Формула R и ТП Военно поделение.';
  const [label] = extractStreetsHeuristic(sz, 'Стара Загора');
  assert(label.endsWith('…') && label.length <= 152 && !/\(\s*[^)]*…$/.test(label), 'the label ends with an ellipsis and not inside an open bracket');
  assert(!/\(през/.test(label) && /\d\.\d{2}\.\d{4}г\.$|…$/.test(label), 'the unclosed "(през работни дн…" tail is gone');
  const [short] = extractStreetsHeuristic('Планирано изключване. Адреси: ИНД.ЗОНА - СЛИВЕН, ТОВАРЕН ДАП, БИНДЕР', 'Сливен');
  assert(short === 'ИНД.ЗОНА - СЛИВЕН, ТОВАРЕН ДАП, БИНДЕР', 'a short free-text address is kept whole');
}

console.log('\n====================================================');
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('====================================================');

// The geocoding service opens a database connection on import; exit explicitly.
process.exit(failed > 0 ? 1 : 0);
