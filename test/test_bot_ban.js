// Short bans for visitors caught acting like bots on the e-mail forms (utils/botBan.js). Pure in-memory logic,
// time is passed in, so nothing here waits and nothing touches a database or the network.
import { recordBotStrike, isBotBanned, botBanSize, resetBotBans, STRIKE } from '../src/utils/botBan.js';

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✅ PASS: ${name}`); passed++; } else { console.error(`  ❌ FAIL: ${name}`); failed++; }
}
const T0 = 1_800_000_000_000;
const MIN = 60 * 1000;

console.log('🧪 BOT BANS');

console.log('\n🔹 Strikes add up to a one-hour ban');
{
  resetBotBans();
  assert(isBotBanned('a', T0) === false, 'an address nobody has struck is not banned');
  const r1 = recordBotStrike('a', STRIKE.HONEYPOT, T0);
  assert(r1.banned && r1.justBanned && isBotBanned('a', T0 + 1), 'filling the hidden field is an immediate ban');
  assert(recordBotStrike('a', STRIKE.TURNSTILE, T0 + MIN).justBanned === false, 'further strikes while banned do not "newly ban" again');
  assert(isBotBanned('a', T0 + 59 * MIN) && !isBotBanned('a', T0 + 61 * MIN), 'the ban lasts one hour');

  resetBotBans();
  recordBotStrike('b', STRIKE.TURNSTILE, T0);
  recordBotStrike('b', STRIKE.TURNSTILE, T0 + MIN);
  recordBotStrike('b', STRIKE.TURNSTILE, T0 + 2 * MIN);
  assert(!isBotBanned('b', T0 + 3 * MIN), 'three failed human checks alone are tolerated (an expired token is not a crime)');
  const r2 = recordBotStrike('b', STRIKE.TOO_FAST, T0 + 4 * MIN);
  assert(r2.banned && r2.justBanned, 'three failed checks + one instant submit reach the limit');
}

console.log('\n🔹 Old strikes are forgotten, addresses are independent');
{
  resetBotBans();
  for (let i = 0; i < 4; i++) recordBotStrike('c', STRIKE.TURNSTILE, T0 + i * MIN);
  const late = recordBotStrike('c', STRIKE.TURNSTILE, T0 + 90 * MIN);
  assert(!late.banned && !isBotBanned('c', T0 + 90 * MIN), 'four strikes, then an hour and a half of quiet: the counter starts over');
  recordBotStrike('d', STRIKE.HONEYPOT, T0);
  assert(isBotBanned('d', T0) && !isBotBanned('c', T0) && !isBotBanned('e', T0), 'a ban touches only the address that earned it');
  assert(isBotBanned(undefined, T0) === false && isBotBanned('', T0) === false, 'a missing address is never banned');
  assert(recordBotStrike('', STRIKE.HONEYPOT, T0).banned === false && recordBotStrike(undefined, 5, T0).banned === false, 'strikes without an address are ignored, never throw');
}

console.log('\n🔹 Memory stays bounded');
{
  resetBotBans();
  for (let i = 0; i < 20600; i++) recordBotStrike('flood-' + i, STRIKE.TURNSTILE, T0 + i);
  assert(botBanSize() <= 20001, `an address flood cannot grow the table without bound (size ${botBanSize()})`);
  resetBotBans();
  recordBotStrike('old', STRIKE.TURNSTILE, T0);
  for (let i = 0; i < 20000; i++) recordBotStrike('n-' + i, STRIKE.TURNSTILE, T0 + 3 * 60 * MIN);
  assert(botBanSize() <= 20001, 'expired entries are dropped when the table is full');
}

console.log('\n====================================================');
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('====================================================');
process.exit(failed > 0 ? 1 : 0);
