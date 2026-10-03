// Reminders: 24 h before, 1 h before and "ended" pushes for an announced outage.
// Runs on the in-memory database with push in simulated mode (both blanked before anything is imported).
process.env.DATABASE_URL = '';
process.env.FIREBASE_SERVICE_ACCOUNT = '';

const { dueReminderKinds, buildReminderMessage, isReminderNight, runReminderJob } = await import('../src/services/reminderService.js');
const { inMemoryDB } = await import('../src/config/db.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✅ PASS: ${name}`); passed++; } else { console.error(`  ❌ FAIL: ${name}`); failed++; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('🧪 REMINDERS');

// 2026-09-28 12:00 in Sofia (summer time, UTC+3)
const now = new Date('2026-09-28T09:00:00Z');
const HOUR = 3600e3;
const MIN = 60e3;
const at = (offsetMs) => new Date(now.getTime() + offsetMs).toISOString();
const TEXT = 'Спиране на тока на ул. Иван Вазов на 29.09.2026 от 09:00 до 17:00 ч.';
const outage = (o) => ({
  id: 'rem-o1', utility_type: 'electricity', provider: 'Тест', city: 'Пловдив', affected_streets: ['ул. Иван Вазов'],
  raw_location_text: TEXT, status: 'scheduled', created_at: at(-48 * HOUR), ...o
});

console.log('\n🔹 When a reminder is due');
assert(same(dueReminderKinds(outage({ start_time: at(23.5 * HOUR), expected_end_time: at(31.5 * HOUR), created_at: at(-2 * HOUR) }), now), ['day_before']), 'about a day before, announced more than a day ahead -> day_before');
assert(same(dueReminderKinds(outage({ start_time: at(23.5 * HOUR), expected_end_time: at(31.5 * HOUR), created_at: at(-1 * HOUR) }), now), []), 'announced less than 25 h ahead -> no 24 h reminder (it would repeat the announcement)');
assert(same(dueReminderKinds(outage({ start_time: at(30 * HOUR), expected_end_time: at(38 * HOUR) }), now), []), 'more than a day away -> nothing yet');
assert(same(dueReminderKinds(outage({ start_time: at(2 * HOUR), expected_end_time: at(10 * HOUR) }), now), []), 'two hours away -> too late for the 24 h one, too early for the 1 h one');
assert(same(dueReminderKinds(outage({ start_time: at(55 * MIN), expected_end_time: at(9 * HOUR) }), now), ['hour_before']), 'under an hour away -> hour_before');
assert(same(dueReminderKinds(outage({ start_time: at(55 * MIN), expected_end_time: at(9 * HOUR), created_at: at(-30 * MIN) }), now), []), 'announced 85 minutes ahead -> no 1 h reminder');
assert(same(dueReminderKinds(outage({ start_time: at(3 * MIN), expected_end_time: at(9 * HOUR) }), now), []), 'about to start -> too late for a reminder');
assert(same(dueReminderKinds(outage({ start_time: at(-5 * HOUR), expected_end_time: at(-20 * MIN), created_at: at(-6 * HOUR) }), now), ['ended']), 'its announced end just passed -> ended');
assert(same(dueReminderKinds(outage({ start_time: at(-9 * HOUR), expected_end_time: at(-4 * HOUR) }), now), []), 'ended 4 hours ago -> too late, nothing');
assert(same(dueReminderKinds(outage({ start_time: at(-5 * HOUR), expected_end_time: at(-20 * MIN), created_at: at(-10 * MIN) }), now), []), 'first seen after it had already ended -> no "ended"');
assert(same(dueReminderKinds(outage({ start_time: at(55 * MIN), expected_end_time: at(9 * HOUR), raw_location_text: 'Ремонт на ул. Иван Вазов на 28.09.2026' }), now), []), 'no clock time in the announcement (estimated) -> no reminders');
assert(same(dueReminderKinds(outage({ start_time: at(55 * MIN), expected_end_time: at(55 * MIN) }), now), []), 'an end not after the start -> nothing');

console.log('\n🔹 No pushes at night (23:00–06:00 Sofia)');
const night = (iso) => isReminderNight(new Date(iso));
assert(night('2026-09-26T19:59:00Z') === false && night('2026-09-26T20:00:00Z') === true, 'summer: 22:59 awake, 23:00 night');
assert(night('2026-09-27T02:59:00Z') === true && night('2026-09-27T03:00:00Z') === false, 'summer: 05:59 night, 06:00 awake');
assert(night('2026-01-15T20:59:00Z') === false && night('2026-01-15T21:00:00Z') === true, 'winter: 22:59 awake, 23:00 night');
assert(night('2026-01-16T03:59:00Z') === true && night('2026-01-16T04:00:00Z') === false, 'winter: 05:59 night, 06:00 awake');

console.log('\n🔹 The messages');
const startTomorrow = '2026-09-29T06:00:00Z'; // 09:00 Sofia
const endTomorrow = '2026-09-29T14:00:00Z'; // 17:00 Sofia
const base = { utility_type: 'electricity', start_time: startTomorrow, expected_end_time: endTomorrow, raw_location_text: TEXT };
let m = buildReminderMessage('day_before', { outage: base, label: 'Вкъщи', street: 'ул. Иван Вазов 5', now });
assert(m.title === '📅 Утре: спиране на тока', `day before, electricity: title (${m.title})`);
assert(m.body === 'Вкъщи · ул. Иван Вазов 5 — от 09:00 до 17:00 ч. Заредете телефона и другите устройства.', `day before, electricity: body (${m.body})`);
m = buildReminderMessage('day_before', { outage: { ...base, utility_type: 'water' }, label: 'Офис', street: 'бул. България 3', now });
assert(m.title === '📅 Утре: спиране на водата' && m.body.endsWith('Съберете малко вода предварително.'), 'day before, water');
m = buildReminderMessage('day_before', { outage: { ...base, utility_type: 'heating' }, label: 'Офис', street: 'бул. България 3', now });
assert(m.title === '📅 Утре: спиране на парното' && m.body === 'Офис · бул. България 3 — от 09:00 до 17:00 ч.', 'day before, heating (no tip)');
m = buildReminderMessage('day_before', { outage: base, label: 'Вкъщи', street: 'ул. Иван Вазов 5', now: new Date('2026-09-26T09:00:00Z') });
assert(m.title === '📅 29.09: спиране на тока', `two days ahead names the date (${m.title})`);
m = buildReminderMessage('hour_before', { outage: base, label: 'Вкъщи', street: 'ул. Иван Вазов 5', now: new Date('2026-09-29T05:03:00Z') });
assert(m.title === '⏰ След 1 час: спиране на тока', `hour before (${m.title})`);
m = buildReminderMessage('hour_before', { outage: base, label: 'Вкъщи', street: 'ул. Иван Вазов 5', now: new Date('2026-09-29T05:30:00Z') });
assert(m.title === '⏰ След 30 мин.: спиране на тока', `a late one-hour reminder says the real minutes (${m.title})`);
m = buildReminderMessage('ended', { outage: base, label: 'Вкъщи', street: 'ул. Иван Вазов 5', now });
assert(m.title === '✅ Ремонтът приключи' && m.body === 'Вкъщи · ул. Иван Вазов 5 — според графика токът трябва да е възстановен. Ако още има проблем, проверете в СпаркСтоп.', `ended (${m.body})`);
m = buildReminderMessage('day_before', { outage: base, label: 'ул. Иван Вазов 5', street: 'ул. Иван Вазов 5', now });
assert(m.body.startsWith('ул. Иван Вазов 5 — '), 'a label that is just the address is not repeated');
m = buildReminderMessage('day_before', { outage: { ...base, raw_location_text: 'Спиране от 09:00 до 17:00 ч.', start_time: '2026-09-29T06:00:00Z', expected_end_time: '2026-10-01T14:00:00Z' }, label: 'Вкъщи', street: 'ул. Иван Вазов 5', now });
assert(m.body.includes('от 29.09 09:00 до 01.10 17:00 ч.'), `an outage over several days shows both dates (${m.body})`);

console.log('\n🔹 The job (in-memory database, simulated push)');
// An empty stage, so whatever the local dev file holds cannot interfere; the real data is put back at the end.
const original = { addresses: inMemoryDB.saved_addresses, outages: inMemoryDB.outages, log: inMemoryDB.notification_log };
inMemoryDB.saved_addresses = [];
inMemoryDB.outages = [];
inMemoryDB.notification_log = [];
const address = (id, userId, city, street, token) => ({ id, user_id: userId, label: 'Вкъщи', city, street_name: street, notifications_enabled: true, fcm_token: token, created_at: at(-1 * HOUR) });
inMemoryDB.saved_addresses.push(
  address('rem-a1', 'rem-u1', 'Пловдив', 'ул. Иван Вазов 5', 'rem-tok-1'),
  address('rem-a2', 'rem-u2', 'София', 'ул. Иван Вазов 5', 'rem-tok-2'),
  address('rem-a3', 'rem-u3', 'Пловдив', 'ул. Кукуш 9', 'rem-tok-3')
);
inMemoryDB.outages.push(outage({ id: 'rem-hour', start_time: at(55 * MIN), expected_end_time: at(9 * HOUR) }));
const historyOf = (userId) => inMemoryDB.notification_log.filter((n) => n.user_id === userId).map((n) => n.message);

let r = await runReminderJob(now);
assert(r.sent === 1, `one device gets the 1 h reminder — the one whose address is on the street (${r.sent})`);
assert(same(historyOf('rem-u1'), ['⏰ След 1 час: спиране на тока']), 'and it shows in that user\'s history');
assert(historyOf('rem-u2').length === 0 && historyOf('rem-u3').length === 0, 'another town and another street get nothing');
r = await runReminderJob(new Date(now.getTime() + 2 * MIN));
assert(r.sent === 0, 'the next run does not send it again');

inMemoryDB.outages.push(outage({ id: 'rem-day', start_time: at(23.5 * HOUR), expected_end_time: at(31.5 * HOUR), created_at: at(-2 * HOUR), provider: 'Друг' }));
r = await runReminderJob(now);
assert(r.sent === 1 && historyOf('rem-u1').includes('📅 Утре: спиране на тока'), 'the 24 h reminder is sent once');

inMemoryDB.outages.push(outage({ id: 'rem-end', start_time: at(-5 * HOUR), expected_end_time: at(-20 * MIN), created_at: at(-6 * HOUR), provider: 'Трети' }));
r = await runReminderJob(now);
assert(r.sent === 1 && historyOf('rem-u1').includes('✅ Ремонтът приключи'), 'the "ended" push is sent once');

const nightNow = new Date('2026-09-28T21:30:00Z'); // 00:30 Sofia
inMemoryDB.outages.push(outage({ id: 'rem-night', start_time: new Date(nightNow.getTime() + 55 * MIN).toISOString(), expected_end_time: new Date(nightNow.getTime() + 9 * HOUR).toISOString(), provider: 'Нощен' }));
r = await runReminderJob(nightNow);
assert(r.skipped === 'night' && r.sent === 0, 'at night the job sends nothing');

// put the local data back
inMemoryDB.saved_addresses = original.addresses;
inMemoryDB.outages = original.outages;
inMemoryDB.notification_log = original.log;

console.log(`\n🏁 TEST RESULTS: ${passed} Passed, ${failed} Failed`);
process.exit(failed === 0 ? 0 : 1);
