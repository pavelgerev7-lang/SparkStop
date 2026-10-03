// At most 10 accounts a day from one network address. Runs on the in-memory database (DATABASE_URL blanked before
// anything is imported), never touching production, and no e-mail leaves the test.
process.env.DATABASE_URL = '';
process.env.RESEND_API_KEY = '';
process.env.RESEND_SENDER_EMAIL = '';
delete process.env.MAX_ACCOUNTS_PER_IP_PER_DAY;
delete process.env.NODE_ENV;
delete process.env.RENDER;

const { startRegistration, verifyRegistration } = await import('../src/services/authService.js');
const { MAX_ACCOUNTS_PER_IP_PER_DAY, accountsCreatedFromIp, assertIpMayCreateAccount, recordAccountCreated, hashIp } = await import('../src/utils/signupLimit.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✅ PASS: ${name}`); passed++; } else { console.error(`  ❌ FAIL: ${name}`); failed++; }
}
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

console.log('🧪 ACCOUNTS PER NETWORK ADDRESS');

const stamp = Date.now();
const ipA = '203.0.113.7';
const ipB = '203.0.113.8';
const emailA = (i) => `limit_a${i}_${stamp}@sparkstop.test`;

console.log('\n🔹 The ceiling');
const MAX = MAX_ACCOUNTS_PER_IP_PER_DAY;
assert(MAX === 25, 'the default ceiling is 25 accounts a day per address');

// MAX + 1 registrations are STARTED first (nothing is created yet, so none is refused), then confirmed one by one
const started = [];
for (let i = 1; i <= MAX + 1; i++) {
  const r = await startRegistration(emailA(i), 'Parola123', '', ipA);
  started.push(r.simulatedCode);
}
assert(started.every(Boolean), `${MAX + 1} registrations could be started from one address while no account existed yet`);

let created = 0;
for (let i = 1; i <= MAX; i++) {
  const r = await verifyRegistration(emailA(i), started[i - 1], ipA);
  if (r && r.success) created++;
}
assert(created === MAX, `the first ${MAX} confirmations from the address create their accounts`);
assert(await accountsCreatedFromIp(ipA) === MAX, `the counter shows ${MAX} accounts from that address`);

const overTheLimit = await throws(() => verifyRegistration(emailA(MAX + 1), started[MAX], ipA));
assert(overTheLimit && overTheLimit.statusCode === 429 && new RegExp(String(MAX)).test(overTheLimit.message), `confirmation number ${MAX + 1} is refused with 429 and says the maximum is ${MAX}`);

const fresh = await throws(() => startRegistration(`limit_new_${stamp}@sparkstop.test`, 'Parola123', '', ipA));
assert(fresh && fresh.statusCode === 429, 'a new registration from the same address is refused before any e-mail is sent');

console.log('\n🔹 Others are not affected');
const other = await startRegistration(`limit_b1_${stamp}@sparkstop.test`, 'Parola123', '', ipB);
assert(!!other.simulatedCode, 'a different address can still register');
const okB = await verifyRegistration(`limit_b1_${stamp}@sparkstop.test`, other.simulatedCode, ipB);
assert(okB && okB.success && await accountsCreatedFromIp(ipB) === 1, 'and its own counter starts at 1');

const noIp = await startRegistration(`limit_noip_${stamp}@sparkstop.test`, 'Parola123');
assert(!!noIp.simulatedCode, 'a call without an address (tests, tools) is not limited');
assert(await throws(() => assertIpMayCreateAccount(null)) === null && await throws(() => assertIpMayCreateAccount(undefined)) === null, 'no address = no limit');

console.log('\n🔹 It is a rolling 24 hours, not for ever');
const nowPlus23h = Date.now() + 23 * 3600 * 1000;
const nowPlus25h = Date.now() + 25 * 3600 * 1000;
assert(await accountsCreatedFromIp(ipA, nowPlus23h) === MAX, `after 23 hours the ${MAX} accounts still count`);
assert(await accountsCreatedFromIp(ipA, nowPlus25h) === 0, 'after 25 hours they no longer count');
assert(await throws(() => assertIpMayCreateAccount(ipA, nowPlus25h)) === null, 'so the address may register again the next day');
const before = await accountsCreatedFromIp('198.51.100.1');
await recordAccountCreated('198.51.100.1');
assert(await accountsCreatedFromIp('198.51.100.1') === before + 1, 'recording an account raises the counter by one');

console.log('\n🔹 The address itself is never kept');
const h = hashIp(ipA);
assert(h !== ipA && !h.includes('203.0.113') && /^[0-9a-f]{32}$/.test(h), 'only a 32-character keyed hash is stored');
assert(hashIp(ipA) === hashIp(ipA) && hashIp(ipA) !== hashIp(ipB), 'the same address always gives the same hash, different addresses different ones');

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
