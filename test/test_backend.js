import { saveUserAddress, getUserAddresses } from '../src/services/addressService.js';
import { parseOutageTextWithAI, parseOutageTextHeuristic } from '../src/services/aiParserService.js';
import { upsertOutage, checkAddressOutageStatus, getLiveMapOutages } from '../src/services/outageService.js';
import { notifyAffectedUsersForOutage } from '../src/services/notificationService.js';
import { inMemoryDB, query } from '../src/config/db.js';

let passed = 0;
let failed = 0;

// When .env's DATABASE_URL points at the real (production) Postgres — a
// deliberate, documented setup for testing against real data before
// deploying — every upsertOutage()/saveUserAddress() call below writes
// straight into that same live database, not a throwaway in-memory one.
// Confirmed live: before this cleanup existed, a single `npm test` run left
// 5 synthetic "active" outages (real provider names, real-sounding streets
// like "бул. Цар Борис III Обединител") sitting on the public live map for
// up to 1.5 hours — genuinely misleading for real users — plus stray
// "test-user-limit-123" rows in saved_addresses that broke the NEXT run's
// address-limit test by starting from a non-empty count. Tracking every
// outage id this run creates and sweeping both tables in `finally` (so it
// still runs if an assertion throws) keeps every test run self-contained
// regardless of which backend is live.
const TEST_USER_ID = 'test-user-limit-123';
const createdOutageIds = [];

async function cleanupTestData() {
  // query() is a no-op (returns null) when Postgres isn't available, so
  // these are safe to call unconditionally regardless of backend.
  if (createdOutageIds.length > 0) {
    try { await query(`DELETE FROM outages WHERE id = ANY($1)`, [createdOutageIds]); } catch (e) {}
  }
  try { await query(`DELETE FROM saved_addresses WHERE user_id = $1`, [TEST_USER_ID]); } catch (e) {}
  const idSet = new Set(createdOutageIds);
  inMemoryDB.outages = inMemoryDB.outages.filter((o) => !idSet.has(o.id));
  inMemoryDB.saved_addresses = inMemoryDB.saved_addresses.filter((a) => a.user_id !== TEST_USER_ID);
}

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    failed++;
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING SPARKDROP BACKEND INTEGRATION TESTS');
  console.log('====================================================\n');

  // Defensive: sweep any leftovers from a previous run that crashed before
  // reaching its own cleanup (e.g. a genuine assertion failure).
  await cleanupTestData();

  try {

  // Test 1: AI / Heuristic Parser
  console.log('🔹 1. Testing AI & Bulgarian Text Parser...');
  const sampleRawText = 'Поради авария на ул. Иван Вазов и ул. Шипка се спира водоподаването от 10:00 до 16:30';
  const parsedOutage = await parseOutageTextWithAI(sampleRawText, 'Софийска вода');

  assert(parsedOutage.utility_type === 'water', 'Utility type detected as "water"');
  assert(parsedOutage.provider === 'Софийска вода', 'Provider detected as "Софийска вода"');
  assert(parsedOutage.city === 'София', 'City detected as "София"');
  assert(parsedOutage.affected_streets.some(s => s.includes('Иван Вазов')), 'Street "ул. Иван Вазов" extracted');
  assert(parsedOutage.affected_streets.some(s => s.includes('Шипка')), 'Street "ул. Шипка" extracted');
  assert(['active', 'resolved', 'scheduled'].includes(parsedOutage.status), 'Status detected as valid lifecycle status');
  assert(Boolean(parsedOutage.expected_end_time), 'expected_end_time is valid ISO timestamp');

  // Test 2: Address Limit (Max 3)
  console.log('\n🔹 2. Testing 3-Address Strict Limit per User...');
  const testUserId = TEST_USER_ID;

  await saveUserAddress({
    user_id: testUserId,
    label: 'Вкъщи',
    city: 'София',
    street_name: 'ул. Иван Вазов 10'
  });
  await saveUserAddress({
    user_id: testUserId,
    label: 'Офис',
    city: 'София',
    street_name: 'бул. България 45'
  });
  await saveUserAddress({
    user_id: testUserId,
    label: 'Вила',
    city: 'София',
    street_name: 'ул. Оборище 5'
  });

  const addresses = await getUserAddresses(testUserId);
  assert(addresses.length === 3, 'User successfully has 3 saved addresses');

  let limitThrown = false;
  try {
    await saveUserAddress({
      user_id: testUserId,
      label: '4-ти адрес (трябва да даде грешка)',
      city: 'София',
      street_name: 'ул. Раковски 100'
    });
  } catch (err) {
    limitThrown = true;
  }
  assert(limitThrown, '4th address attempt threw strict limit exception');

  // Test 3: Upsert Outage & Push Notification dispatch
  console.log('\n🔹 3. Testing Outage Upsert and Push Notification Matching...');
  // Add a user with FCM token
  inMemoryDB.users.push({
    id: testUserId,
    email: 'test@sparkdrop.bg',
    fcm_token: 'test_token_fcm_12345'
  });

  const newOutage = await upsertOutage({
    utility_type: 'water',
    provider: 'Софийска вода',
    city: 'София',
    raw_location_text: sampleRawText,
    affected_streets: ['ул. Иван Вазов', 'ул. Шипка'],
    status: 'active',
    expected_end_time: new Date(Date.now() + 5400000).toISOString()
  });
  createdOutageIds.push(newOutage.id);

  assert(Boolean(newOutage.id), 'Outage successfully upserted/created with ID');

  // Test 4: Address Outage Traffic Light Status & Countdown
  console.log('\n🔹 4. Testing Address Outage Status Check (Traffic Light & Countdown)...');
  const checkRed = await checkAddressOutageStatus('ул. Иван Вазов 10', 'София');
  assert(checkRed.status_code === 'red', 'Traffic light status is "red" for affected street');
  assert(checkRed.countdown !== null, 'Countdown timer object is present');
  assert(checkRed.countdown.total_seconds > 0, 'Countdown timer has remaining seconds');

  const checkGreen = await checkAddressOutageStatus('ул. Несъществуваща 99', 'София');
  assert(checkGreen.status_code === 'green', 'Traffic light status is "green" for safe street');

  // Test 5: a Топлофикация София notice belongs to ONE district — the same block list under another district
  // must not be merged into the first district's row (it used to: an Изток notice ended up in a Дианабад row).
  console.log('\n🔹 5. Testing that Топлофикация София notices of different districts are never merged...');
  const heatStart = new Date(Date.now() + 3600000).toISOString();
  const heatEnd = new Date(Date.now() + 7200000).toISOString();
  const heatA = await upsertOutage({ utility_type: 'heating', provider: 'Топлофикация София', city: 'София', region: 'ТестРайонА', raw_location_text: 'Авария по топлопреносната мрежа: спряно е топлоподаването на бл.9991 в кв. ТестРайонА. от 10:00 ч. до 11:00 ч.', affected_streets: ['бл.9991', 'ТестРайонА'], status: 'scheduled', start_time: heatStart, expected_end_time: heatEnd });
  createdOutageIds.push(heatA.id);
  const heatB = await upsertOutage({ utility_type: 'heating', provider: 'Топлофикация София', city: 'София', region: 'ТестРайонБ', raw_location_text: 'Авария по топлопреносната мрежа: спряно е топлоподаването на бл.9991 в кв. ТестРайонБ. от 10:00 ч. до 11:00 ч.', affected_streets: ['бл.9991', 'ТестРайонБ'], status: 'scheduled', start_time: heatStart, expected_end_time: heatEnd });
  createdOutageIds.push(heatB.id);
  assert(Boolean(heatA.id) && Boolean(heatB.id) && heatA.id !== heatB.id, 'the same block list under two districts stays two rows');

  // Test 6: Bulgarian Cities & Street Autocomplete
  console.log('\n🔹 6. Testing Bulgarian Cities & Street Autocomplete...');
  const { BULGARIAN_CITIES, getStreetSuggestions } = await import('../src/services/autocompleteService.js');
  assert(BULGARIAN_CITIES.length >= 28, 'All 28 Bulgarian provinces and major cities are present');
  
  const sofiaStreets = await getStreetSuggestions('София', 'бълг');
  assert(sofiaStreets.some(s => s.street_name.includes('България')), 'Sofia autocomplete found "бул. България"');

  const plovdivStreets = await getStreetSuggestions('Пловдив', 'руски');
  assert(plovdivStreets.some(s => s.street_name.includes('Руски')), 'Plovdiv autocomplete found "бул. Руски"');

  const varnaStreets = await getStreetSuggestions('Варна', 'сливница');
  assert(varnaStreets.some(s => s.street_name.includes('Сливница')), 'Varna autocomplete found "бул. Сливница"');

  // Test 7: Nationwide Outage Status Check
  console.log('\n🔹 7. Testing Nationwide Outage Status across Bulgarian Cities...');
  createdOutageIds.push((await upsertOutage({
    utility_type: 'electricity',
    provider: 'EVN България',
    city: 'Пловдив',
    raw_location_text: 'Планирана профилактика по бул. Цар Борис III Обединител',
    affected_streets: ['бул. Цар Борис III Обединител'],
    status: 'active',
    expected_end_time: new Date(Date.now() + 3600000).toISOString()
  })).id);
  createdOutageIds.push((await upsertOutage({
    utility_type: 'water',
    provider: 'ВиК Варна',
    city: 'Варна',
    raw_location_text: 'Авария по бул. Сливница, водоподаването е спряно до отстраняване на повредата',
    affected_streets: ['бул. Сливница'],
    status: 'active',
    expected_end_time: new Date(Date.now() + 3600000).toISOString()
  })).id);
  createdOutageIds.push((await upsertOutage({
    utility_type: 'water',
    provider: 'ВиК Бургас',
    city: 'Бургас',
    raw_location_text: 'Авария по бул. Стефан Стамболов',
    affected_streets: ['бул. Стефан Стамболов'],
    status: 'active',
    expected_end_time: new Date(Date.now() + 3600000).toISOString()
  })).id);
  createdOutageIds.push((await upsertOutage({
    utility_type: 'electricity',
    provider: 'Енерго-Про (ЕРП Север)',
    city: 'Велико Търново',
    raw_location_text: 'Планов ремонт по ул. Независимост',
    affected_streets: ['ул. Независимост'],
    status: 'active',
    expected_end_time: new Date(Date.now() + 3600000).toISOString()
  })).id);
  createdOutageIds.push((await upsertOutage({
    id: 'outage-vt-resolved-test',
    utility_type: 'water',
    provider: 'ВиК Йовковци',
    city: 'Велико Търново',
    raw_location_text: 'Авариен ремонт на 20.08.2026 г. по ул. Шемшевско шосе',
    affected_streets: ['ул. Шемшевско шосе'],
    status: 'resolved',
    expected_end_time: '2026-08-20T12:00:00.000Z'
  })).id);

  const plovdivCheck = await checkAddressOutageStatus('бул. Цар Борис III Обединител', 'Пловдив');
  assert(plovdivCheck.status_code === 'red', 'Plovdiv outage detected on "бул. Цар Борис III Обединител"');
  
  const varnaCheck = await checkAddressOutageStatus('бул. Сливница 20', 'Варна');
  assert(varnaCheck.status_code === 'red', 'Varna outage detected on "бул. Сливница"');

  const burgasCheck = await checkAddressOutageStatus('бул. Стефан Стамболов', 'Бургас');
  assert(burgasCheck.status_code === 'red', 'Burgas outage detected on "бул. Стефан Стамболов"');

  const vtElecCheck = await checkAddressOutageStatus('ул. Независимост', 'Велико Търново');
  assert(vtElecCheck.status_code === 'red', 'Veliko Tarnovo active electricity outage detected on "ул. Независимост"');

  const vtResolvedCheck = await checkAddressOutageStatus('ул. Шемшевско шосе', 'Велико Търново');
  assert(vtResolvedCheck.status_code === 'green', 'Veliko Tarnovo past water repair (20.08) correctly returns green (resolved)');

  // Test 8: Zero False Positives & Rigorous Accuracy
  console.log('\n🔹 8. Testing Zero False Positives & Precision Boundary Matching...');
  const { isAddressAffected } = await import('../src/utils/streetNormalizer.js');

  // 8.1 Distinct street names with same first name MUST NOT match
  assert(!isAddressAffected('ул. Иван Михайлов 12', ['ул. Иван Вазов']), 'FAIL PREVENTED: "Иван Михайлов" does NOT match "Иван Вазов"');
  assert(!isAddressAffected('бул. Васил Априлов', ['бул. Васил Левски']), 'FAIL PREVENTED: "Васил Априлов" does NOT match "Васил Левски"');
  assert(!isAddressAffected('бул. Цар Симеон', ['бул. Цар Борис III']), 'FAIL PREVENTED: "Цар Симеон" does NOT match "Цар Борис III"');
  assert(!isAddressAffected('ул. Стефан Караджа', ['ул. Стефан Стамболов']), 'FAIL PREVENTED: "Стефан Караджа" does NOT match "Стефан Стамболов"');

  // 8.2 True street variations MUST match
  assert(isAddressAffected('ул. Иван Вазов №12, вх. А', ['ул. Иван Вазов']), 'PASS: Full street variation matched');
  assert(isAddressAffected('бул. 6-ти Септември', ['бул. Шести Септември']), 'PASS: Numeral date variation matched');
  assert(isAddressAffected('бул. Цар Борис 3', ['бул. Цар Борис III']), 'PASS: Roman numeral matched');

  // 8.3 Number ranges
  const rangeAnnouncement = 'Авария по бул. България от №40 до №60';
  assert(isAddressAffected('бул. България 45', ['бул. България'], rangeAnnouncement), 'PASS: House #45 inside #40-#60 is affected');
  assert(!isAddressAffected('бул. България 120', ['бул. България'], rangeAnnouncement), 'FAIL PREVENTED: House #120 outside #40-#60 is NOT affected');

  // 8.4 Block numbers
  const blockAnnouncement = 'Ремонт на водопровод в кв. Младост 1, бл. 74, бл. 75';
  assert(isAddressAffected('кв. Младост 1, бл. 74', ['кв. Младост 1'], blockAnnouncement), 'PASS: Bl. 74 is affected');
  // Test 9: Date Parsing & Past Outage Lifecycle Status
  console.log('\n🔹 9. Testing Date Parsing & Past Outage Lifecycle Status...');
  const { parseBulgarianDateTime } = await import('../src/services/aiParserService.js');
  
  // Past date announcement (e.g. 20.08)
  const pastAnnouncement = 'Авариен ремонт на водопроводната мрежа, на 20.08.2026 г. от 09:00 до 14:00 ч. за ул. Шемшевско шосе';
  const pastParsed = parseBulgarianDateTime(pastAnnouncement);
  assert(pastParsed.status === 'resolved', 'Past date (20.08.2026) is automatically recognized as "resolved"');
  assert(new Date(pastParsed.expected_end_time) < new Date(), 'Past date expected_end_time is in the past');

  // Future date announcement — deliberately says "утре" (tomorrow) rather
  // than a bare "10:00 до 18:00" with no date: a bare same-day window is
  // only "future" relative to whatever moment the test happens to run,
  // making the assertion flaky (confirmed live: this failed for real once
  // wall-clock time passed 18:00 Sofia time on the day it was run, with
  // zero code change — the window had genuinely, correctly resolved).
  // "утре" is unambiguously after "today" no matter what time it is.
  const futureAnnouncement = 'Планов ремонт на напорен водопровод утре от 10:00 до 18:00 ч. по бул. България';
  const futureParsed = parseBulgarianDateTime(futureAnnouncement);
  assert(futureParsed.status === 'active' || futureParsed.status === 'scheduled', 'Future announcement has active/scheduled status');

  } catch (err) {
    console.error('❌ Test run crashed:', err);
    failed++;
  } finally {
    await cleanupTestData();
  }

  console.log('\n====================================================');
  console.log(`🏁 TEST RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
