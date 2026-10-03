// Quiet hours: the background jobs pause between 01:00 and 06:00 Sofia time so the Neon database can suspend.
// Runs on the in-memory database (DATABASE_URL blanked before anything is imported), never touching production.
process.env.DATABASE_URL = '';

const { parseQuietHours, isQuietHours, describeQuietHours, DEFAULT_QUIET_HOURS } = await import('../src/utils/quietHours.js');
const { canReuseLiveMapRows } = await import('../src/services/outageService.js');
const { query, getOutagesWriteVersion } = await import('../src/config/db.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✅ PASS: ${name}`); passed++; } else { console.error(`  ❌ FAIL: ${name}`); failed++; }
}

console.log('🧪 QUIET HOURS');

console.log('\n🔹 Parsing the setting');
assert(DEFAULT_QUIET_HOURS === '1-6', 'the default window is 01:00–06:00');
assert(JSON.stringify(parseQuietHours('1-6')) === '{"start":1,"end":6}', '"1-6" parses');
assert(JSON.stringify(parseQuietHours(' 23 - 5 ')) === '{"start":23,"end":5}', 'spaces are tolerated, wrap-around window parses');
assert(parseQuietHours('off') === null && parseQuietHours('OFF') === null && parseQuietHours('none') === null, '"off"/"none" switch the pause off');
assert(parseQuietHours('') === null && parseQuietHours(undefined) === null, 'empty means no window (the default is applied by the caller)');
assert(parseQuietHours('abc') === null && parseQuietHours('1-99') === null && parseQuietHours('3-3') === null && parseQuietHours('1:00-6:00') === null, 'invalid or empty windows are ignored, never crash');
assert(describeQuietHours({ spec: '1-6', timeZone: 'Europe/Sofia' }) === '01:00–06:00 Europe/Sofia', 'readable description');
assert(describeQuietHours({ spec: 'off' }) === 'off', 'description when off');

console.log('\n🔹 Sofia clock, summer time (UTC+3)');
const at = (iso, spec = '1-6') => isQuietHours(new Date(iso), { spec, timeZone: 'Europe/Sofia' });
assert(at('2026-09-25T21:59:00Z') === false, '00:59 local is awake');
assert(at('2026-09-25T22:00:00Z') === true, '01:00 local starts the quiet window');
assert(at('2026-09-26T02:59:00Z') === true, '05:59 local is still quiet');
assert(at('2026-09-26T03:00:00Z') === false, '06:00 local is awake again (the first scrape of the day runs)');
assert(at('2026-09-26T12:00:00Z') === false, 'midday is awake');

console.log('\n🔹 Sofia clock, winter time (UTC+2) — the same local hours');
assert(at('2026-01-15T22:59:00Z') === false, '00:59 local is awake');
assert(at('2026-01-15T23:00:00Z') === true, '01:00 local starts the quiet window');
assert(at('2026-01-16T03:59:00Z') === true, '05:59 local is still quiet');
assert(at('2026-01-16T04:00:00Z') === false, '06:00 local is awake again');

console.log('\n🔹 Windows across midnight and the whole day');
assert(at('2026-09-25T19:59:00Z', '23-5') === false && at('2026-09-25T20:00:00Z', '23-5') === true, '23-5: starts at 23:00');
assert(at('2026-09-26T01:59:00Z', '23-5') === true && at('2026-09-26T02:00:00Z', '23-5') === false, '23-5: ends at 05:00');
assert(at('2026-09-26T12:00:00Z', '0-24') === true, '0-24 is always quiet');
assert(at('2026-09-25T22:00:00Z', 'off') === false, 'off is never quiet');
assert(isQuietHours(new Date('2026-09-25T22:00:00Z'), { spec: '1-6', timeZone: 'Not/AZone' }) === true, 'an unknown time zone falls back to Sofia instead of crashing');

console.log('\n🔹 Live map: outage rows are reused at night only while nothing wrote to the table');
const t0 = 1_000_000_000_000;
const cache = { rows: [], fetchedAt: t0, version: 7 };
assert(canReuseLiveMapRows(cache, { quiet: true, now: t0 + 60_000, version: 7 }) === true, 'quiet + unchanged table + fresh copy -> no database read');
assert(canReuseLiveMapRows(cache, { quiet: false, now: t0 + 60_000, version: 7 }) === false, 'awake hours always read the database');
assert(canReuseLiveMapRows(cache, { quiet: true, now: t0 + 60_000, version: 8 }) === false, 'a write to the outages table invalidates the copy');
assert(canReuseLiveMapRows(cache, { quiet: true, now: t0 + 31 * 60_000, version: 7 }) === false, 'a copy older than 30 minutes is read again');
assert(canReuseLiveMapRows(null, { quiet: true, now: t0, version: 7 }) === false, 'no copy yet -> read');

console.log('\n🔹 The write counter sees every statement that changes outages');
const v0 = getOutagesWriteVersion();
await query('SELECT id FROM outages WHERE status = $1', ['active']);
assert(getOutagesWriteVersion() === v0, 'a SELECT does not count');
await query('UPDATE outages SET status = $1 WHERE id = $2', ['resolved', 'x']);
await query('  insert into outages (city) values ($1)', ['x']);
await query('DELETE FROM outages WHERE id = $1', ['x']);
assert(getOutagesWriteVersion() === v0 + 3, 'UPDATE / INSERT INTO / DELETE FROM outages each count (any case, leading spaces)');
await query('UPDATE outages_archive SET a = 1');
await query('UPDATE saved_addresses SET a = 1');
assert(getOutagesWriteVersion() === v0 + 3, 'other tables (even a name that starts with "outages") do not count');

console.log(`\n🏁 TEST RESULTS: ${passed} Passed, ${failed} Failed`);
process.exit(failed === 0 ? 0 : 1);
