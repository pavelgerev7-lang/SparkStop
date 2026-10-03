// Registration: "send the code again" must keep the password the person chose (it used to replace it with a
// fixed placeholder), and the optional Cloudflare Turnstile check must be inert until its keys are set.
// Runs on the in-memory database (DATABASE_URL blanked before anything is imported), never touching production.
process.env.DATABASE_URL = '';
// No real e-mail may ever leave a test: with no key the service answers in simulated (dev) mode.
process.env.RESEND_API_KEY = '';
process.env.RESEND_SENDER_EMAIL = '';
delete process.env.TURNSTILE_SECRET_KEY;
delete process.env.TURNSTILE_SITE_KEY;

const { startRegistration, resendRegistrationCode, verifyRegistration, loginUser } = await import('../src/services/authService.js');
const { isTurnstileEnabled, getTurnstileSiteKey, verifyTurnstileToken } = await import('../src/services/turnstileService.js');
const { formBotReason } = await import('../src/utils/botTrap.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✅ PASS: ${name}`); passed++; } else { console.error(`  ❌ FAIL: ${name}`); failed++; }
}
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

console.log('🧪 REGISTRATION RESEND + TURNSTILE');

console.log('\n🔹 Resending the code keeps the chosen password');
{
  const email = `resend_${Date.now()}@sparkstop.test`;
  const first = await startRegistration(email, 'MyOwnPass77');
  assert(!!first.simulatedCode, 'registration started, a code was issued');

  const tooSoon = await throws(() => resendRegistrationCode(email));
  assert(tooSoon && tooSoon.statusCode === 429, 'asking again within the cooldown is refused (429)');

  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 1000;
  let resent;
  try { resent = await resendRegistrationCode(email); } finally { Date.now = realNow; }
  assert(resent && resent.success && !!resent.simulatedCode, 'after the cooldown a new code is issued');

  const oldCode = first.simulatedCode !== resent.simulatedCode ? await throws(() => verifyRegistration(email, first.simulatedCode)) : null;
  assert(first.simulatedCode === resent.simulatedCode || (oldCode && /код/i.test(oldCode.message)), 'the previous code no longer works');

  await verifyRegistration(email, resent.simulatedCode);
  const login = await loginUser(email, 'MyOwnPass77');
  assert(login && login.user && login.user.email === email, 'the account can log in with the password typed in the form');
  const dummy = await throws(() => loginUser(email, 'DummyPassword123'));
  assert(!!dummy, 'the old placeholder password does NOT open the account');

  const nobody = await throws(() => resendRegistrationCode(`nobody_${Date.now()}@sparkstop.test`));
  assert(nobody && /чакаща регистрация/.test(nobody.message), 'no pending registration for that e-mail → refused');
}

console.log('\n🔹 Turnstile is inert without its keys, strict once they are set');
{
  assert(isTurnstileEnabled() === false && getTurnstileSiteKey() === '', 'off by default: no site key is handed to the browser');
  const off = await verifyTurnstileToken('anything');
  assert(off.ok === true && off.skipped === true, 'off: every request passes unchecked');

  process.env.TURNSTILE_SITE_KEY = 'site-key-for-test';
  assert(isTurnstileEnabled() === false, 'a site key alone does not switch it on (the secret is needed to verify)');
  process.env.TURNSTILE_SECRET_KEY = 'secret-for-test';
  assert(isTurnstileEnabled() === true && getTurnstileSiteKey() === 'site-key-for-test', 'both keys set: on, the site key is exposed');
  const none = await verifyTurnstileToken('');
  const huge = await verifyTurnstileToken('x'.repeat(5000));
  const notString = await verifyTurnstileToken({ a: 1 });
  assert(!none.ok && !huge.ok && !notString.ok, 'on: a missing, oversized or non-string token is refused without calling Cloudflare');
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.TURNSTILE_SITE_KEY;
}

console.log('\n🔹 Free bot traps on the e-mail-sending forms');
{
  assert(formBotReason({ email: 'a@b.co', hp_contact: '', formElapsedMs: 9000 }) === null, 'a person: empty hidden field, form open for seconds → fine');
  assert(formBotReason({ email: 'a@b.co' }) === null, 'an older cached page that sends neither field is not judged by them');
  assert(formBotReason({ hp_contact: 'http://spam.example' }) === 'honeypot', 'the hidden field filled in → bot');
  assert(formBotReason({ hp_contact: '   ' }) === null, 'a field holding only spaces is not a fill');
  assert(formBotReason({ hp_contact: '', formElapsedMs: 120 }) === 'too-fast', 'submitted 0.12 s after the form appeared → bot');
  assert(formBotReason({ formElapsedMs: 800 }) === null && formBotReason({ formElapsedMs: 799 }) === 'too-fast', 'the limit is 0.8 s');
  assert(formBotReason(null) === null && formBotReason('x') === null && formBotReason({ formElapsedMs: 'fast' }) === null, 'garbage bodies never throw');
}

console.log('\n====================================================');
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('====================================================');
process.exit(failed > 0 ? 1 : 0);
