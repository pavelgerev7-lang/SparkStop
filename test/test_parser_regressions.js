// Regression tests for the 4 real parsing bugs found and fixed this
// session, each against the ACTUAL bulletin text that exposed it (not a
// synthetic simplification) — so a future change to the shared parsing
// pipeline (textCleaner.js / aiParserService.js) that reintroduces any of
// these fails loudly here instead of silently reaching production again.
// Pure functions, no DB/network needed — runs standalone.
import { cleanOutageAnnouncementText, isAnnouncementIndicatingNoOutage } from '../src/utils/textCleaner.js';
import { extractStreetsHeuristic, hasExplicitTimeInText, parseBulgarianDateTime, parseOutageTextHeuristic } from '../src/services/aiParserService.js';
import { buildItemFingerprint } from '../src/services/scraperService.js';
import { cleanStreetForSearch, formatSettlementLabel, getSettlementCoordinates } from '../src/services/geocodingService.js';

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
console.log('🧪 PARSER REGRESSION TESTS (real bulletin texts)');
console.log('====================================================\n');

// ---------------------------------------------------------------------
// Bug 1: ВиК Плевен — "гр. Плевен" extracted as its own fake street
// alongside the real ж.к. Дружба, both from a title+body glued together
// with no separator ("...ЕООД, град Плевен Аварийно прекъсване...").
// ---------------------------------------------------------------------
console.log('🔹 1. "City as street" (ВиК Плевен) — bare city dropped when a real street exists');
{
  const plevenGlued = 'Аварийно прекъсване на водоподаването: Водоснабдяване и Канализация ЕООД, град Плевен Аварийно прекъсване на водоподаването септември 19, 2026 Любомир Димов При извършване на строително-монтажни работи (СМР) от външна фирма изпълнител е възникнала авария в гр. Плевен, ж.к. „Дружба“. За времето от 14:30 ч. до 19:30 ч. ще бъде нарушено водоподаването в района от бл. 422 до бл. 424. След приключване на ремонтните дейности водоснабдяването ще бъде възстановено поетапно, съобразно техническите възможности на водоснабдителната система. „ВиК“ – Плевен благодари на своите потребители за разбирането.';
  const streets = extractStreetsHeuristic(plevenGlued);
  assert(streets.length === 1 && streets[0] === 'ж.к. Дружба', `only the real street survives, got: ${JSON.stringify(streets)}`);
}
console.log('   Regression guard: a bulletin naming ONLY its town keeps that info');
{
  const bareTown = 'Поради авария е спряно водоподаването в гр. Бяла от 09:00 до 17:00 часа.';
  const streets = extractStreetsHeuristic(bareTown);
  assert(streets.length === 1 && streets[0] === 'гр. Бяла', `bare-town-only bulletin still keeps it, got: ${JSON.stringify(streets)}`);
}

// ---------------------------------------------------------------------
// Bug 2: ВиК Берковица — no clock time anywhere in the bulletin ("до
// отстраняване на проблема"), must NOT be reported as if a real time
// range was stated.
// ---------------------------------------------------------------------
console.log('\n🔹 2. Fabricated time range (ВиК Берковица) — no time in source is detected as such');
{
  const berkText = '260629 - аварийно спиране на водоподаването: Поради отстраняване на водопроводна авария на главен водопровод ф300Е в района на кръстовището на ул. „Антон Страшимиров“ и ул. „Коцина бара“ в гр. Берковица, ще бъде спряно водоподаването до отстраняване на проблема.';
  assert(hasExplicitTimeInText(berkText) === false, 'dateless/timeless "until fixed" bulletin correctly has no explicit time');
}
console.log('   Regression guard: bulletins that DO state a real time are still detected');
{
  const withRange = 'ще бъде спряно водоподаването от 09:00 до 17:00 часа.';
  const withUntil = 'водоподаването ще бъде спряно до 15:00 часа.';
  assert(hasExplicitTimeInText(withRange) === true, 'explicit "от X до Y" range detected');
  assert(hasExplicitTimeInText(withUntil) === true, 'explicit bare "до X" detected');
}
console.log('   Bug 2b (ВиК Сливен): a REAL start time with an explicitly open end is still not a real range');
{
  // Date computed relative to "today" (not hardcoded) so this test keeps
  // testing the same real bug indefinitely instead of quietly starting to
  // fail once a fixed calendar date ages into the past. Yesterday, not
  // today — so start_time (18:00 that day) has already passed regardless
  // of what time of day this test happens to run, landing the open-ended
  // fallback window (start .. start+2d) squarely around "now" either way.
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
  const dateStr = `${String(yesterday.getDate()).padStart(2, '0')}.${String(yesterday.getMonth() + 1).padStart(2, '0')}.${yesterday.getFullYear()}`;
  const slivenText = `Водоснабдяване и Канализация – Сливен уведомява своите потребители, че поради авария на ${dateStr}г. от 18:00ч. до отстраняването ще бъде нарушено водоподаването на част от гр.Твърдица – в района на нова кооперация.`;
  assert(hasExplicitTimeInText(slivenText) === false, `a real "от 18:00ч." start does not make a fabricated end look real, got: ${hasExplicitTimeInText(slivenText)}`);
  const r = parseBulgarianDateTime(slivenText);
  assert(r.status === 'active', `still correctly active (not fabricated-resolved), got status: ${r.status}`);
}

// ---------------------------------------------------------------------
// Bug 3: ВиК Плевен — "от бл. 422 до бл. 424." truncated to "...до бл."
// by the naive sentence-splitter treating "бл." as a sentence end.
// ---------------------------------------------------------------------
console.log('\n🔹 3. Truncated number range (ВиК Плевен) — "бл. 422 до бл. 424" survives intact');
{
  const raw = 'Аварийно прекъсване на водоподаването: При извършване на строително-монтажни работи (СМР) от външна фирма изпълнител е възникнала авария в гр. Плевен, ж.к. „Дружба“. За времето от 14:30 ч. до 19:30 ч. ще бъде нарушено водоподаването в района от бл. 422 до бл. 424. След приключване на ремонтните дейности водоснабдяването ще бъде възстановено поетапно, съобразно техническите възможности на водоснабдителната система. „ВиК“ – Плевен благодари на своите потребители за разбирането.';
  const cleaned = cleanOutageAnnouncementText(raw);
  assert(cleaned.includes('бл. 422 до бл. 424'), `full range preserved, got tail: ...${cleaned.slice(-120)}`);
}

// ---------------------------------------------------------------------
// Bug 4a: ВиК Враца — "от с. Осен до с. Чирен" (a pipeline route naming
// two villages) only ever produced "с. Осен".
// ---------------------------------------------------------------------
console.log('\n🔹 4a. Missed village in "от X до Y" (ВиК Враца) — both villages extracted');
{
  const vracaText = 'Водоснабдяване и канализация ООД – Враца уведомява своите потребители, че поради авария на надвеждащ водопровод от с. Осен до с. Чирен, днес 18.09.2026г. е спряно водоподаването до отстраняване на аварията.';
  const streets = extractStreetsHeuristic(vracaText);
  assert(streets.includes('с. Осен') && streets.includes('с. Чирен'), `both villages present, got: ${JSON.stringify(streets)}`);
}

// ---------------------------------------------------------------------
// Bug 4b: ЕРП Север (Габрово/Трявна) — a long village list with some
// consecutive villages separated by only a space, no comma, silently
// merged into the previous village's captured name and lost.
// ---------------------------------------------------------------------
console.log('\n🔹 4b. Missed villages in a long ЕРП Север list (Габрово/Трявна) — no-comma-separated names extracted');
{
  const erpText = 'От 23.09.2026 г. до 24.09.2026 г. В периода 8:00 ч. до 9:00 ч. Поради неотложни ремонтни дейности на съоръженията за доставка на електроенергия, ще бъде прекъснато електрозахранването в районите на: Община Трявна: с. Даевци, с. Стръмци, с. Стража, с. Фъревци, с. Павлевци, с. Никачковци, с. Армянковци, с. Демиевци, с. Райнушковци, с. Ошани, с. Белица, с. Царето, с. Чифлика, с. Михаилчета, с. Уруцити, с. Раевци, с. Драндари, с. Глутници, с. Маневци, с. Ябълковци, с. Дървари, с. Дамяновци, с. Йовчевци с. Кисийци, с. Добревци, с. Черновръх, с. Чакали с. Малки Станчевци, с. Големи Станчевци, с. Томчевци, с. Сухолоевци с. Град Трявна: кв. Стояновци,кв. Христовци.';
  const streets = extractStreetsHeuristic(erpText);
  assert(streets.includes('с. Кисийци'), `"с. Кисийци" (no comma before it) found, got ${streets.length} total entries`);
  assert(streets.includes('с. Малки Станчевци'), '"с. Малки Станчевци" (no comma before it) found');
  assert(streets.includes('с. Голями Станчевци') || streets.includes('с. Големи Станчевци'), '"с. Големи Станчевци" still found (regression check)');
}
console.log('   Regression guard: comma-separated village lists still fully extracted');
{
  const commaList = 'засегнати са с. Иваново, с. Петрово и с. Драганово.';
  const streets = extractStreetsHeuristic(commaList);
  assert(streets.length === 3, `all 3 comma/и-separated villages found, got: ${JSON.stringify(streets)}`);
}
console.log('   Regression guard: institution names ("клон") still filtered out, real street kept');
{
  const institutionText = 'Засегнати са клон на банка и ул. Раковски.';
  const streets = extractStreetsHeuristic(institutionText);
  assert(streets.length === 1 && streets[0].includes('Раковски'), `institution name excluded, got: ${JSON.stringify(streets)}`);
}

// ---------------------------------------------------------------------
// Bug 5: ВиК Русе — the scraped widget text repeats "DD.MM HH:MM -
// DD.MM HH:MM" twice ("(20.09 10:00 - 20.09 17:00): 20.09 10:00 - 20.09
// 17:00 ..."). The old time regex accepted "." interchangeably with ":"
// with no way to tell a date from a time, so it matched "10:00 - 20.09"
// and read the date "20.09" as if it were the end time "20:09",
// completely ignoring the real end time "17:00" sitting right after it.
// ---------------------------------------------------------------------
console.log('\n🔹 5a. Date misread as time (ВиК Русе) — real end time found, not the date');
{
  const ruseText1 = '(20.09 10:00 - 20.09 17:00): 20.09 10:00 - 20.09 17:00 Червена вода, ул. Върбан Йорданов Ремонт на водопровод ф80';
  const r1 = parseBulgarianDateTime(ruseText1);
  assert(r1.expected_end_time.includes('14:00:00'), `end time is 17:00 local (14:00 UTC), not 20:09, got: ${r1.expected_end_time}`);

  const ruseText2 = '(20.09 10:00 - 20.09 13:30): 20.09 10:00 - 20.09 13:30 Червена вода, ул. Върбан Йорданов Ремонт на водопровод завършен ф60';
  const r2 = parseBulgarianDateTime(ruseText2);
  assert(r2.expected_end_time.includes('10:30:00'), `end time is 13:30 local (10:30 UTC), not 20:09, got: ${r2.expected_end_time}`);
}
console.log('   Regression guard: normal "от X до Y ч." bulletins still parse correctly');
{
  const normal = parseBulgarianDateTime('Поради авария ще бъде спряно водоподаването от 10:00 до 16:30 ч.');
  assert(normal.expected_end_time.includes('13:30:00'), `normal от-до range still correct, got: ${normal.expected_end_time}`);
}

console.log('\n🔹 5b. "Завършен" in the source text forces status to resolved');
{
  const earlyDone = parseBulgarianDateTime('Ремонт от 08:00 до 23:00 ч. Ремонт на водопровод завършен предсрочно.');
  assert(earlyDone.status === 'resolved', `explicit "завършен" overrides an otherwise-future end time, got status: ${earlyDone.status}`);
}
console.log('   Regression guard: "приключване"/"отстраняване" (different words) do not false-trigger');
{
  const closingPhrase = parseBulgarianDateTime('от 14:30 ч. до 19:30 ч. ще бъде нарушено водоподаването. След приключване на ремонтните дейности водоснабдяването ще бъде възстановено поетапно.');
  assert(closingPhrase.status !== 'resolved' || new Date(closingPhrase.expected_end_time) <= new Date(), '"приключване" (noun, different word) does not falsely mark resolved');
}

console.log('\n🔹 5c. Bare settlement name with no ул./с./кв. prefix (ВиК Русе profilactic bulletins)');
{
  const bareVillage = '(25.09 09:00 - 25.09 16:30): 25.09 09:00 - 25.09 16:30 Лом Черковна, профилактика на електрозахранването Ще бъде прекъснато водоподаването поради профилактика на енергопреносната мрежа';
  const streets = extractStreetsHeuristic(bareVillage);
  assert(streets.includes('с. Лом Черковна'), `bare village name (real settlement, verified via geocoding lookup) found and typed "с." (a village is not a street) instead of the generic fallback, got: ${JSON.stringify(streets)}`);
}

console.log('\n🔹 5d. Genuine multi-day range with no year/"г." marker (ВиК Русе "ул. Даскал Драгни") — end date not glued to start date');
{
  // Dates relative to today (the fixed 09.09–25.09 of the original case went stale once 25.09 had passed).
  const dm = (d) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const startDay = new Date(Date.now() - 16 * 86400000);
  const endDay = new Date(Date.now() + 2 * 86400000);
  const multiDay = `(${dm(startDay)} 08:00 - ${dm(endDay)} 16:00): ${dm(startDay)} 08:00 - ${dm(endDay)} 16:00 Русе, ул. "Даскал Драгни" № 2 - № 5 Ремонт на водопровод`;
  const r = parseBulgarianDateTime(multiDay);
  const endDate = new Date(r.expected_end_time);
  assert(endDate.getUTCMonth() === endDay.getUTCMonth() && endDate.getUTCDate() === endDay.getUTCDate(), `end date is ${dm(endDay)}, not glued to the ${dm(startDay)} start date, got: ${r.expected_end_time}`);
  assert(r.status !== 'resolved' || endDate.getTime() > Date.now(), `a genuinely still-ongoing 16-day repair is not marked resolved on day 1, got status: ${r.status}, end: ${r.expected_end_time}`);
}
console.log('   Regression guard: the equally common same-day case is unaffected');
{
  const sameDay = parseBulgarianDateTime('(20.09 10:00 - 20.09 17:00): 20.09 10:00 - 20.09 17:00 Червена вода, ул. Върбан Йорданов Ремонт на водопровод ф80');
  const endDate = new Date(sameDay.expected_end_time);
  assert(endDate.getUTCMonth() === 8 && endDate.getUTCDate() === 20, `same-day range still ends on 20.09, got: ${sameDay.expected_end_time}`);
}

// ---------------------------------------------------------------------
// Bug 6: ВиК Русе's own vik-ruse.com widget gives each .item neither a
// real href nor an id, so scrapeProviderTargetItems() built a synthetic
// sourceUrl (-> source_announcement_key) from a fingerprint of the raw
// element text. That text starts with the item's own "DD.MM HH:MM -
// DD.MM HH:MM" schedule, which legitimately CHANGES as the SAME real
// outage's window narrows or gets marked "завършен" — producing a
// DIFFERENT key for the same real-world outage on its next re-scrape,
// which upsertOutage()'s matchesOutage() then treated as an unrelated
// new announcement (see buildItemFingerprint()'s own comment for the
// full mechanism). Reproduced live: one Червена вода outage produced 16
// duplicate resolved rows in under 3 hours this way, while the original
// row stayed stuck 'active' with a stale end time and a running
// countdown well after the source itself marked it завършен.
// ---------------------------------------------------------------------
console.log('\n🔹 6. Stable item fingerprint (ВиК Русе) — same outage, changed schedule/status, same key');
{
  // Real vik-ruse.com markup, two scrapes of the SAME real outage: still
  // in progress, then finished early and marked завършен.
  const addressText = 'Червена вода, ул. Върбан Йорданов ';
  const fullTextInProgress = '20.09 10:00 - 20.09 17:00 Червена вода, ул. Върбан Йорданов Ремонт на водопровод ф80';
  const fullTextResolved = '20.09 10:00 - 20.09 13:30 Червена вода, ул. Върбан Йорданов Ремонт на водопровод завършен ф60';
  const fp1 = buildItemFingerprint(addressText, fullTextInProgress);
  const fp2 = buildItemFingerprint(addressText, fullTextResolved);
  assert(fp1 === fp2, `fingerprint stays identical across a schedule/status update, got "${fp1}" vs "${fp2}"`);
  assert(fp1 === 'Червена вода, ул. Върбан Йорданов', `address element wins over raw text when present, got: "${fp1}"`);
}
console.log('   Regression guard: without an address element, the volatile leading date/status is still stripped');
{
  const noAddressInProgress = buildItemFingerprint('', '20.09 10:00 - 20.09 17:00 Ветово, ул. Райна Княгиня 2 Ремонт на водопровод ф125');
  const noAddressResolved = buildItemFingerprint('', '20.09 08:30 - 20.09 13:30 Ветово, ул. Райна Княгиня 2 Ремонт на водопровод завършен ф125');
  assert(noAddressInProgress === noAddressResolved, `fallback (no .address) still matches across the same update, got "${noAddressInProgress}" vs "${noAddressResolved}"`);
}
console.log('   Regression guard: genuinely different items (Кюстендилска вода-style, no href/id) still get distinct fingerprints');
{
  const itemA = buildItemFingerprint('', 'Авария на водопровод в с. Ново село, ул. Първа №5, отстраняване до 18:00 ч.');
  const itemB = buildItemFingerprint('', 'Авария на водопровод в с. Старо село, ул. Втора №12, отстраняване до 20:00 ч.');
  assert(itemA !== itemB, `two genuinely different no-href/no-id items still get different fingerprints, got "${itemA}" vs "${itemB}"`);
}

// ---------------------------------------------------------------------
// Bug 7: Софийска вода (ArcGIS) / Топлофикация София (toplo.bg) both give
// REAL, structured start/end times (never a text-parsed guess) — but
// hasExplicitTimeInText only ever recognizes a literal "HH:MM"-shaped
// pattern in raw_location_text, since free text is the only signal it has
// for every OTHER provider. Without embedding the real time as text (see
// scrapeSofiaWaterGis()/scrapeSofiaHeatingToplo() in scraperService.js), a
// genuinely precise structured end time was shown as "До отстраняване на
// аварията" as if it were unknown — confirmed live for Софийска вода.
// ---------------------------------------------------------------------
console.log('\n🔹 7. Structured-source times (Софийска вода / Топлофикация София) recognized as real');
{
  const swReal = 'Софийска вода уведомява: Планирано спиране - Зона за спиране: ул. Х. от 08:30 ч. до 16:30 ч.';
  assert(hasExplicitTimeInText(swReal) === true, `a real structured end time embedded as text is recognized, got: ${hasExplicitTimeInText(swReal)}`);

  const toploReal = 'Планов ремонт по топлопреносната мрежа: спряно е топлоподаването в кв. Люлин (целият квартал). от 07:00 ч. до 19:00 ч.';
  assert(hasExplicitTimeInText(toploReal) === true, `toplo.bg real structured end time recognized, got: ${hasExplicitTimeInText(toploReal)}`);
}
console.log('   Regression guard: a genuinely missing structured end time still shows as honestly estimated');
{
  const swOpen = 'Софийска вода уведомява: Аварийно спиране - Зона за спиране: ул. Y. от 09:15 ч. до отстраняване.';
  assert(hasExplicitTimeInText(swOpen) === false, `missing END_H still correctly reports no real end time, got: ${hasExplicitTimeInText(swOpen)}`);

  const toploNone = 'Авария по топлопреносната мрежа: спряно е топлоподаването в кв. Люлин (целият квартал).';
  assert(hasExplicitTimeInText(toploNone) === false, `missing FromDate/UntilDate still correctly reports no real time, got: ${hasExplicitTimeInText(toploNone)}`);
}

// ---------------------------------------------------------------------
// Bug 8: ЕРП Север's own "м-ст" (not "м-т") abbreviation for "местност"
// (locality) went unrecognized as a prefix, so "част" — a legitimate
// stopword elsewhere — truncated the capture right before the real
// locality name, losing it entirely and collapsing several genuinely
// different Varna-area localities onto the same bare "гр. Варна -"
// entry (and, on the map, onto Varna's city-center fallback point).
// ---------------------------------------------------------------------
console.log('\n🔹 8. "м-ст" locality abbreviation (ЕРП Север, Варна) recovered instead of lost');
{
  const varnaText = 'На 23.09.2026 г. В периода 8:30 ч. до 17:00 ч. Поради обезопасяване на съоръженията за доставка на електроенергия, ще бъде прекъснато електрозахранването в районите на: гр. Варна - част от м-ст Акчелар и част от м-ст Сотира, електрозахранени от ТП 1819. Проверете за Вашия обект тук';
  const streets = extractStreetsHeuristic(varnaText);
  assert(streets.includes('м-ст Акчелар'), `first locality recovered, got: ${JSON.stringify(streets)}`);
  assert(streets.includes('м-ст Сотира'), `second locality recovered, got: ${JSON.stringify(streets)}`);
  assert(!streets.includes('гр. Варна -'), `no more bare truncated "гр. Варна -" entry, got: ${JSON.stringify(streets)}`);
}

// ---------------------------------------------------------------------
// Bug 9: cleanStreetForSearch() (geocodingService.js) feeds Nominatim's
// live search — confirmed against the real API: "м-ст Акчелар, Варна,
// България" returns ZERO results, while stripping the generic Bulgarian
// locality word first ("Акчелар, Варна, България") returns a real,
// precise OSM point. Different named localities within the same town
// were collapsing onto one shared city-level pin not because of any
// pin-count limit, but because the search string itself never matched.
// ---------------------------------------------------------------------
console.log('\n🔹 9. Locality prefix stripped before geocoding search (Nominatim query construction)');
{
  const a = cleanStreetForSearch('м-ст Акчелар');
  const b = cleanStreetForSearch('местност Сотира');
  const c = cleanStreetForSearch('м-т Акчелар');
  assert(a === 'Акчелар', `"м-ст" stripped, got: "${a}"`);
  assert(b === 'Сотира', `"местност" stripped, got: "${b}"`);
  assert(c === 'Акчелар', `"м-т" stripped, got: "${c}"`);
}
console.log('   Regression guard: ordinary street cleaning is unaffected');
{
  const street = cleanStreetForSearch('ул. Раковски 15');
  assert(street === 'Раковски', `plain street still cleaned as before, got: "${street}"`);
}

// ---------------------------------------------------------------------
// Bug 10: ЕРП Север's own "Горна Оряховица" bulletins use a literal
// double-comma (two U+002C) as an opening quote and doubled U+2018 as the
// closing one ("ул. ,,Росица‘‘"). extractStreetsHeuristic() splits its
// input on every comma BEFORE any prefix matching runs, so those literal
// commas inside the fake quote marks tore "ул." away from its own street
// name — every single "ул. ,,X‘‘" in the bulletin silently vanished,
// collapsing a real 13-street bulletin down to the bare city-name
// fallback with zero streets.
// ---------------------------------------------------------------------
console.log('\n🔹 10. Fake double-comma/doubled-U+2018 quote marks (ЕРП Север, Горна Оряховица) no longer shred street names');
{
  const raw = 'На 23.09.2026 г. В периода 9:15 ч. до 16:30 ч. Поради обслужване на съоръженията за доставка на електроенергия, ще бъде прекъснато електрозахранването в районите на: гр. Горна Оряховица: ул. ,,Росица‘‘, ул. ,,ген.Столетов‘‘, ул. ,,Кирил и Методий‘‘, ул. ,,отец Паисий‘‘ – до болницата, ул. ,,Люлин‘‘, ул. ,,Кремиковци‘‘,ул. ,,Х.Димитър‘‘,ул. ,,ген.Скобелев‘‘,ул. ,,Тунджа‘‘, ул. ,,П.Пенев‘‘,ул. ,,Струма‘‘,ул. ,,Наум‘‘,ул. ,,Осъм‘‘, около Дълбок зимник, Лимонадена фабрика и района срещу болницата.. Проверете за Вашия обект тук';
  const streets = extractStreetsHeuristic(raw);
  assert(streets.includes('ул. Росица'), `first street recovered, got: ${JSON.stringify(streets)}`);
  assert(streets.includes('ул. Тунджа'), `a middle street recovered, got: ${JSON.stringify(streets)}`);
  assert(streets.includes('ул. Осъм'), `last street recovered, got: ${JSON.stringify(streets)}`);
  assert(streets.length >= 10, `most of the real 13-street list recovered, got ${streets.length}: ${JSON.stringify(streets)}`);
  assert(!streets.includes('гр. Горна Оряховица'), `no longer collapses to the bare city fallback, got: ${JSON.stringify(streets)}`);
}
console.log('   Regression guard: doubled-U+2018-only variant (no leading double-comma) still works');
{
  const raw2 = 'районите на: Горна Оряховица: ул.‘‘Раховец‘‘ №1 до №3, ул. ‘‘Дружба‘‘ ,ул. ‘‘Теменуга‘‘';
  const streets = extractStreetsHeuristic(raw2);
  assert(streets.includes('ул. Раховец'), `quote-adjacent (no space) variant recovered, got: ${JSON.stringify(streets)}`);
  assert(streets.includes('ул. Дружба'), `second street recovered, got: ${JSON.stringify(streets)}`);
  assert(streets.includes('ул. Теменуга'), `third street recovered, got: ${JSON.stringify(streets)}`);
}
console.log('   Regression guard: a real, legitimate double comma (rare, but not this quote pattern) does not misfire');
{
  // ",," only strips when immediately followed by a non-space character
  // (the actual quote-substitute shape) — a real "X,, Y" with a space
  // after the comma pair is left alone.
  const untouched = 'ул. Иван Вазов,, ул. Раковски';
  const streets = extractStreetsHeuristic(untouched);
  assert(streets.some((s) => s.includes('Иван Вазов')), `ordinary comma usage still extracts fine, got: ${JSON.stringify(streets)}`);
}

// ---------------------------------------------------------------------
// Bug 11: parseOutageTextHeuristic()'s city detection only ever scanned
// BULGARIAN_CITY_NAMES (real towns/cities) — a bulletin naming ONLY a
// village never matched anything there, so `city` silently stayed at
// whatever default the caller passed. For ЕРП Север/EVN's own per-region
// scraper loops that default is the whole macro-region's own name (e.g.
// "Варна", covering many towns and villages) — confirmed live: 161
// currently-active outages had city === region this way, showing a real
// village outage (e.g. "с. Овчага") under the header "гр. Варна" as if it
// were the regional capital itself.
// ---------------------------------------------------------------------
console.log('\n🔹 11. Village-only bulletin no longer falls back to the whole region name as its city');
{
  const raw = 'От 23.09.2026 г. до 25.09.2026 г. В периода 9:00 ч. до 17:00 ч. Поради неотложни ремонтни дейности на съоръженията за доставка на електроенергия, ще бъде прекъснато електрозахранването в районите на: с. Овчага.';
  const r = parseOutageTextHeuristic(raw, 'Енерго-Про (ЕРП Север)', 'Варна', '');
  assert(r.city === 'Овчага', `city is the real village, not the region fallback "Варна", got: "${r.city}"`);
}
console.log('   Regression guard: a real city bulletin still detects the real city as before');
{
  const raw = 'Поради авария ще бъде прекъснато електрозахранването в гр. Варна, ж.к. Възраждане.';
  const r = parseOutageTextHeuristic(raw, 'Енерго-Про (ЕРП Север)', 'Варна', '');
  assert(r.city === 'Варна', `real city bulletin unaffected, got: "${r.city}"`);
}

console.log('\n🔹 12. formatSettlementLabel() uses the settlement\'s own real type, not a hardcoded "гр."');
{
  assert(formatSettlementLabel('Овчага', '', 'Варна') === 'с. Овчага', `village gets "с." prefix, got: "${formatSettlementLabel('Овчага', '', 'Варна')}"`);
  assert(formatSettlementLabel('Горна Оряховица', '', 'Велико Търново') === 'гр. Горна Оряховица', `town gets "гр." prefix, got: "${formatSettlementLabel('Горна Оряховица', '', 'Велико Търново')}"`);
}
console.log('   Regression guard: an unrecognized name still falls back to "гр." (previous default behavior)');
{
  const label = formatSettlementLabel('НеСъществуващоМясто123', '', '');
  assert(label === 'гр. НеСъществуващоМясто123', `unknown name defaults to "гр." as before, got: "${label}"`);
}

// ---------------------------------------------------------------------
// Bug 13: the 5,265-settlement registry has TWO villages named
// "Дойранци" — one in Шумен province, one in Кърджали province, ~300km
// apart in reality. The Шумен entry's own stored coordinate was a stray
// copy of Кърджали's (confirmed against a live Nominatim lookup before
// fixing the registry data), and the geocode cache key (city+street only,
// no region) meant whichever one resolved FIRST in a given process could
// silently poison the shared cache entry for the other. Confirmed live:
// 2 real currently-active ЕРП Север outages for "с. Дойранци, Шумен" were
// showing a pin ~300km away in Кърджали province.
// ---------------------------------------------------------------------
console.log('\n🔹 13. Same-named settlements in different regions resolve to their own distinct coordinates');
{
  const shumen = getSettlementCoordinates('Дойранци', '', 'Шумен');
  const kardzhali = getSettlementCoordinates('Дойранци', '', 'Кърджали');
  assert(shumen.region === 'Шумен', `Шумен lookup returns the Шумен entry, got region: ${shumen.region}`);
  assert(kardzhali.region === 'Кърджали', `Кърджали lookup returns the Кърджали entry, got region: ${kardzhali.region}`);
  const distDeg = Math.hypot(shumen.lat - kardzhali.lat, shumen.lng - kardzhali.lng);
  assert(distDeg > 1, `the two real villages are genuinely far apart (~300km), not near-duplicate coords, got delta: ${distDeg.toFixed(3)}deg`);
}

// ---------------------------------------------------------------------
// Bug 14: getSettlementCoordinates() must never fall through to an
// unconstrained name-only match once a region/municipality WAS specified —
// confirmed real risk (same class of bug as Bug 13's Дойранци collision):
// asking for a settlement name in a region it genuinely isn't in used to
// silently ignore that region and return the FIRST same-named entry found
// anywhere in the 5,265-settlement registry, regardless of province. Now it
// must degrade to that region's own centroid (isRegionFallback: true)
// instead of guessing a wrong-region match.
// ---------------------------------------------------------------------
console.log('\n🔹 14. Region-constrained settlement lookup never falls through to a wrong-region match');
{
  // "Дойранци" genuinely exists only in Шумен and Кърджали (see Bug 13) —
  // asking for it in Пловдив (a real, valid province, but not one it's in)
  // must not silently return either of those two.
  const wrongRegion = getSettlementCoordinates('Дойранци', '', 'Пловдив');
  assert(wrongRegion !== null, `a region-constrained miss still returns an area fallback, not null, got: ${wrongRegion}`);
  assert(wrongRegion.isRegionFallback === true, `wrong-region query is flagged as a region fallback, got isRegionFallback: ${wrongRegion?.isRegionFallback}`);
  const shumenCoords = getSettlementCoordinates('Дойранци', '', 'Шумен');
  const kardzhaliCoords = getSettlementCoordinates('Дойранци', '', 'Кърджали');
  const distFromShumen = Math.hypot(wrongRegion.lat - shumenCoords.lat, wrongRegion.lng - shumenCoords.lng);
  const distFromKardzhali = Math.hypot(wrongRegion.lat - kardzhaliCoords.lat, wrongRegion.lng - kardzhaliCoords.lng);
  assert(distFromShumen > 0.5 && distFromKardzhali > 0.5, `wrong-region fallback lands in Пловдив, not silently reusing either real Дойранци, got deltas: ${distFromShumen.toFixed(3)}/${distFromKardzhali.toFixed(3)}deg`);

  // Regression guard: an unconstrained lookup (no region/municipality given
  // at all) still works exactly as before — nothing to violate when the
  // caller never claimed a region in the first place.
  const noRegion = getSettlementCoordinates('Дойранци');
  assert(noRegion !== null && !noRegion.isRegionFallback, 'an unconstrained lookup (no region given) still resolves to a real settlement, not a fallback');
}

// ---------------------------------------------------------------------
// Bug 15: parseOutageTextHeuristic()'s village-aware city correction only
// ever fired for an affected_streets entry with an explicit "с."/"село"
// prefix — confirmed real, currently-live bug: vik-ruse.com states village
// names with NO prefix at all ("24.09 08:30 - 24.09 16:30 Пиргово,
// профилактика на електрозахранването"), so `city` stayed stuck on the
// scraper's own defaultCity ("Русе") for 4 real outages actually in с.
// Хотанца/Пиргово/Церовец/Лом Черковна — confirmed live via the production
// API (all 4 showed city_label "гр. Русе" despite the map pin itself
// correctly landing on each village's own coordinates).
// ---------------------------------------------------------------------
console.log('\n🔹 15. Village-aware city correction also fires for a bare (unprefixed) real settlement name');
{
  const pirgovo = parseOutageTextHeuristic('24.09 08:30 - 24.09 16:30 Пиргово, профилактика на електрозахранването', 'ВиК Русе', 'Русе', 'https://vik-ruse.com');
  assert(pirgovo.city === 'Пиргово', `bare village name corrects city away from the defaultCity fallback, got: ${pirgovo.city}`);

  const lomCherkovna = parseOutageTextHeuristic('25.09 09:00 - 25.09 16:30 Лом Черковна, профилактика на електрозахранването', 'ВиК Русе', 'Русе', 'https://vik-ruse.com');
  assert(lomCherkovna.city === 'Лом Черковна', `bare multi-word village name also corrects, got: ${lomCherkovna.city}`);

  // Regression guard: a real outage genuinely IN the default city (a real
  // street, not a bare settlement name) must NOT get "corrected" away.
  const realCityOutage = parseOutageTextHeuristic('Русе, ул. "Даскал Драгни" № 2 - № 5 Ремонт на водопровод', 'ВиК Русе', 'Русе', 'https://vik-ruse.com');
  assert(realCityOutage.city === 'Русе', `a real street in the default city is not mistaken for a village, got: ${realCityOutage.city}`);
}

// ---------------------------------------------------------------------
// Bug 16: parseBulgarianDateTime()'s generic "от D.M.YYYY г. до D.M.YYYY
// г." multi-day-range match picked up whichever occurrence of that SHAPE
// came first in the text, regardless of whether an earlier, more
// authoritative labeled "Дата: D.M.YYYY до D.M.YYYY" field already stated
// the real range. Confirmed real, currently-live bug: an EVN bulletin's own
// free-text "Адреси:" field restates the date in prose with a genuine typo
// on EVN's own end ("от 15.09.2026г. до 17.09.2029г." — 2029 instead of
// 2026) — the earlier "Дата: 15.9.2026 до 17.9.2026" header doesn't match
// the generic pattern at all (no "от", no "г."), so the parser skipped past
// the correct date and used the later typo instead, producing an outage
// that claimed to run for three years (1890+ days remaining) instead of
// two days.
// ---------------------------------------------------------------------
console.log('\n🔹 16. Labeled "Дата: X до Y" field takes priority over a later free-text date range');
{
  const evnText = 'Планирано изключване на електрозахранването в Област Стара Загора. Дата: 15.9.2026 до 17.9.2026. Час: 08:30 - 17:00. Адреси: Поради планова ремонт на ТП-1, изв. Бузовград, на датите: от 15.09.2026г. до 17.09.2029г. в часовият интервал от 08:30ч. до 17:00ч. без електрозахранване ще бъдат всички клиенти.';
  const r = parseBulgarianDateTime(evnText);
  const endYear = new Date(r.expected_end_time).getUTCFullYear();
  assert(endYear === 2026, `labeled "Дата:" field wins over the later free-text typo, expected end year 2026, got: ${endYear} (expected_end_time: ${r.expected_end_time})`);

  // Regression guard: the existing generic "от...г. до...г." multi-day
  // range (ЕРП Север/ВиК planned-works format, no labeled "Дата:" field at
  // all) still works exactly as before.
  const genericRangeText = 'От 14.09.2026 г. до 18.09.2026 г. В периода 9:00 ч. до 16:00 ч. Поради строителни ремонти ще бъде прекъснато водоподаването.';
  const r2 = parseBulgarianDateTime(genericRangeText);
  const endDay2 = new Date(r2.expected_end_time).getUTCDate();
  assert(endDay2 === 18, `generic "от...г. до...г." range unaffected when no labeled "Дата:" field exists, got end day: ${endDay2}`);
}

// ---------------------------------------------------------------------
// Bug 17: the greedy settlement-name capture in extractStreetsHeuristic()
// kept swallowing whatever text followed a village name when the source had
// no punctuation boundary — all confirmed against real live rows: ВиК
// Монтана ("село Лехчево 16.09.2026 г" saved as the city, the bulletin's own
// date glued on), EVN ("С. РАВНА ГОРА - КРАТКОВРЕМЕННИ СМУЩЕНИЯ" — which then
// resolved to an unrelated same-named village ~390km away; "Шейново ТП-6";
// "Дорково части"), ЕРП Север ("Керека живущите"; "Лозен с.Лом Черковна" with
// the next village's prefix glued on with no space), ВиК Варна ("с. Млада
// Гвардия утре 24.09").
// ---------------------------------------------------------------------
console.log('\n🔹 17. Settlement name stops at a date / glued marker / trailing descriptive word');
{
  const montana = parseOutageTextHeuristic('прочети още: Нарушено водоподаване в село Лехчево 16.09.2026 г. Поради авария в село Лехчево ще бъде нарушено водоподаването.', 'ВиК Монтана', 'Монтана', '');
  assert(montana.city === 'Лехчево', `date token no longer glued onto the village name, got: "${montana.city}"`);

  const evn = parseOutageTextHeuristic('Планирано изключване на електрозахранването в Област Бургас. Дата: 24.9.2026 до 24.9.2026. Час: 09:00 - 16:30. Адреси: С. РОСЕН, С. РАВНА ГОРА - КРАТКОВРЕМЕННИ СМУЩЕНИЯ, С. ВЕСЕЛИЕ', 'EVN България', 'Бургас', '');
  assert(!evn.affected_streets.some((s) => /КРАТКОВРЕМЕН/i.test(s)), `trailing descriptive words dropped from the village entry, got: ${JSON.stringify(evn.affected_streets)}`);

  const sheynovo = parseOutageTextHeuristic('Планирано изключване на електрозахранването в Област Стара Загора. Дата: 30.9.2026 до 30.9.2026. Час: 08:30 - 16:30. Адреси: с. Шейново ТП-6, ул. Опълченска', 'EVN България', 'Стара Загора', '');
  assert(sheynovo.city === 'Шейново', `substation code with a dash/digit ends the name, got: "${sheynovo.city}"`);

  const erp = parseOutageTextHeuristic('Поради неотложни ремонтни дейности ще бъде прекъснато електрозахранването в районите на: с. Лозен с.Лом Черковна, с. Николаево, с. Камен.', 'Енерго-Про (ЕРП Север)', 'Велико Търново', '');
  assert(erp.affected_streets.includes('с. Лом Черковна') && erp.city === 'Лозен', `glued "с." prefix starts a new village instead of extending the previous name, got: ${JSON.stringify([erp.city, erp.affected_streets])}`);

  const varna = parseOutageTextHeuristic('Без вода ЕТР Провадия 23.09.2026 г. Поради планови ремонтни дейности без вода ще бъдат абонатите на с. Млада Гвардия утре 24.09 . прочети още', 'ВиК Варна', 'Варна', '');
  assert(varna.city === 'Млада Гвардия', `"утре"/date tail no longer part of the name, got: "${varna.city}"`);

  // Regression guard: a genuine multi-word village name is untouched.
  const real = parseOutageTextHeuristic('Поради авария ще бъде спряно водоподаването в с. Горна Оряховица, ул. Шипка.', 'ВиК Габрово', 'Габрово', '');
  assert(/Горна Оряховица/.test(real.affected_streets.join(' ')), `real multi-word settlement name preserved, got: ${JSON.stringify(real.affected_streets)}`);
}

// ---------------------------------------------------------------------
// Bug 18: parseOutageTextHeuristic()'s provider auto-detection matched the
// bare substrings "евн"/"чез" anywhere in the text. Confirmed live: a ВиК
// Варна page scrape listing its "ЕТР Девня" branch (д-ЕВН-я) was saved as an
// EVN България outage — a navigation-menu blob attributed to the wrong
// company entirely.
// ---------------------------------------------------------------------
console.log('\n🔹 18. Provider auto-detection only matches EVN/ЧЕЗ as whole words');
{
  const devnya = parseOutageTextHeuristic('"Водоснабдяване и канализация - Варна" ООД: Начало ЕТР Провадия ЕТР Девня Долни Чифлик', 'ВиК Варна', 'Варна', '');
  assert(devnya.provider === 'ВиК Варна', `"Девня" is not mistaken for EVN, got: "${devnya.provider}"`);
  const realEvn = parseOutageTextHeuristic('Уведомление на ЕВН: прекъсване на електрозахранването в с. Иваново', 'Софийска вода', 'София', '');
  assert(realEvn.provider === 'EVN България', `a real standalone "ЕВН" mention is still detected, got: "${realEvn.provider}"`);
}

// ---------------------------------------------------------------------
// Bug 19: a site's own navigation chrome scraped as if it were an outage.
// Confirmed live: ВиК Варна's per-region page was scraped whole — menu,
// "Моля изберете" dropdown labels and all — giving the same village/day a
// second junk record next to the real one; ВиК София област's archive
// page 2 ("Начало / Аварии / Page 2" breadcrumb) was scraped the same way.
// ---------------------------------------------------------------------
console.log('\n🔹 19. Navigation/breadcrumb text is filtered out, real announcements are kept');
{
  assert(isAnnouncementIndicatingNoOutage('"Водоснабдяване и канализация - Варна" ООД: Начало ЕТР Провадия Съобщения за аварии Без вода Карта на ремонтите Моля изберете ЕТР Варна ЕТР Девня с. Млада Гвардия утре 24.09') === true, 'a page with a "Моля изберете" dropdown is treated as navigation, not an outage');
  assert(isAnnouncementIndicatingNoOutage('Аварии: гр.София, бул. Рожен №15 Начало / Аварии / Page 2 Авария на водопровод Район Ихтиман, с. Веринско') === true, 'a "Начало / Аварии /" breadcrumb trail is treated as navigation');
  assert(isAnnouncementIndicatingNoOutage('Без вода: Без вода ЕТР Провадия/Провадия 23.09.2026 г. Поради планови ремонтни дейности без вода ще бъдат абонатите на с. Млада Гвардия утре 24.09 . прочети още') === false, 'the real single announcement on that same site is still kept');
}

console.log('\n====================================================');
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('====================================================');

if (failed > 0) {
  process.exit(1);
}
