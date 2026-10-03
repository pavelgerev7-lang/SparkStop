import crypto from 'crypto';
import axios from 'axios';
import { query, inMemoryDB, persistLocalDB, recordLogin } from '../config/db.js';
import { assertIpMayCreateAccount, recordAccountCreated } from '../utils/signupLimit.js';

// Gmail SMTP was the first attempt here, but Render (like most PaaS free
// tiers) silently blocks outbound SMTP ports to prevent abuse — the send
// call just hung forever in production (worked fine locally, where no such
// block exists) instead of failing with a clear error. Resend's
// transactional email API is a plain HTTPS POST, the same kind of outbound
// call that already works fine for Gemini/Firebase/Nominatim, so it isn't
// subject to that block. Real sending only activates once RESEND_API_KEY is
// set; without it the app falls back to the existing console-log +
// simulatedCode behavior, the same graceful-degradation pattern already
// used for FCM when no Firebase service account is configured — local dev
// keeps working with zero setup.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_SENDER_EMAIL = process.env.RESEND_SENDER_EMAIL || 'contact@sparkstopapp.com';
const isRealEmailConfigured = Boolean(RESEND_API_KEY);

if (!isRealEmailConfigured) {
  console.warn('⚠️ RESEND_API_KEY not set — verification codes will be shown in the UI instead of emailed. Set it to send real emails.');
}

// In-memory store for pending email verification codes
// Format: { email: { code, passwordHash, salt, expiresAt, type: 'registration' | 'reset' } }
const pendingCodes = new Map();

// Session tokens are HMAC-signed with this. A fixed string baked into source
// would let anyone who has read this file forge an admin session (the admin
// check is just "does the token's email match the owner's"), so without a
// real JWT_SECRET env var this generates a random secret once per process
// start instead — existing sessions just get invalidated on restart/deploy,
// same as if the secret had rotated, rather than being permanently
// guessable from the repo. Set JWT_SECRET in the environment for stable
// sessions across restarts.
if (!process.env.JWT_SECRET) {
  console.warn('⚠️ JWT_SECRET is not set — using a random per-process secret. Sessions (including admin login) will be invalidated on every restart/deploy until JWT_SECRET is set in the environment.');
}
const SESSION_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// Nothing on this whole auth surface was rate-limited: a scripted client
// could grind a 6-digit code (1-in-1,000,000) unthrottled for its whole
// 15-minute lifetime, or brute-force a login password with no lockout at
// all. This caps failed attempts per email per action, independent of how
// many fresh codes get requested in between (a counter that reset on every
// new code request would let an attacker just request a new code to buy
// another 5 guesses indefinitely) — cleared only on success or once the
// window itself expires.
const attemptCounts = new Map(); // `${type}:${email}` -> { count, windowStart }
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const TOO_MANY_ATTEMPTS_MSG = 'Твърде много опити. Моля, изчакайте 15 минути и опитайте отново.';

function checkNotRateLimited(type, email) {
  const key = `${type}:${email}`;
  const entry = attemptCounts.get(key);
  if (entry && Date.now() - entry.windowStart <= ATTEMPT_WINDOW_MS && entry.count >= MAX_ATTEMPTS) {
    const error = new Error(TOO_MANY_ATTEMPTS_MSG);
    error.statusCode = 429;
    throw error;
  }
}

function recordFailedAttempt(type, email) {
  const key = `${type}:${email}`;
  const entry = attemptCounts.get(key);
  if (!entry || Date.now() - entry.windowStart > ATTEMPT_WINDOW_MS) {
    attemptCounts.set(key, { count: 1, windowStart: Date.now() });
  } else {
    entry.count += 1;
  }
}

function clearAttempts(type, email) {
  attemptCounts.delete(`${type}:${email}`);
}

// Separate, shorter-window cooldown on REQUESTING a fresh code (as opposed
// to guessing one) — otherwise nothing stops repeatedly spamming an email
// address with codes (a nuisance/harassment vector independent of the guess
// limiter above, which only throttles verification, not requests).
const lastCodeRequestAt = new Map();
const CODE_REQUEST_COOLDOWN_MS = 30 * 1000;

function checkCodeRequestCooldown(type, email) {
  const key = `${type}:${email}`;
  const last = lastCodeRequestAt.get(key);
  if (last && Date.now() - last < CODE_REQUEST_COOLDOWN_MS) {
    const error = new Error('Моля, изчакайте малко преди да заявите нов код.');
    error.statusCode = 429;
    throw error;
  }
  lastCodeRequestAt.set(key, Date.now());
}

/**
 * Hash password securely using crypto.scrypt
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return {
    hash: derivedKey.toString('hex'),
    salt
  };
}

/**
 * Verify password against stored hash and salt
 */
export function verifyPassword(password, hash, salt) {
  const derivedKey = crypto.scryptSync(password, salt, 64);
  const keyBuffer = Buffer.from(hash, 'hex');
  return crypto.timingSafeEqual(derivedKey, keyBuffer);
}

/**
 * Validate password requirements: at least 6 characters and contains at least 1 number
 */
export function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, message: 'Моля, въведете парола.' };
  }
  if (password.length < 6) {
    return { valid: false, message: 'Паролата трябва да бъде поне 6 символа.' };
  }
  if (!/\d/.test(password)) {
    return { valid: false, message: 'Паролата трябва да съдържа поне една цифра (0-9).' };
  }
  return { valid: true };
}

/**
 * Generate a 6-digit numerical security code
 */
function generate6DigitCode() {
  // crypto.randomInt, not Math.random(): a security code must not come from a predictable generator.
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Sends a security code via email. Uses Resend's HTTPS transactional email
 * API when configured; otherwise falls back to logging the code and
 * returning it to the caller so the frontend can display it directly
 * (dev/demo mode only — this is exactly the bypass a real launch needs to
 * NOT have, since it lets anyone "verify" an email address they don't
 * actually own).
 */
async function sendEmailSecurityCode(email, code, subject, purpose) {
  if (isRealEmailConfigured) {
    try {
      await axios.post('https://api.resend.com/emails', {
        from: `СпаркСтоп <${RESEND_SENDER_EMAIL}>`,
        to: [email],
        subject,
        text: `Твоят код за сигурност е: ${code}\n\n${purpose}\nВалиден е 15 минути. Ако не си заявявал/а това, просто игнорирай този имейл.`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0f172a;color:#e2e8f0;border-radius:12px;">
            <h2 style="color:#22d3ee;margin-top:0;">СпаркСтоп</h2>
            <p style="color:#cbd5e1;">${purpose}</p>
            <div style="font-size:32px;font-weight:bold;letter-spacing:6px;text-align:center;padding:16px;margin:16px 0;background:#1e293b;border-radius:8px;color:#fbbf24;">${code}</div>
            <p style="color:#94a3b8;font-size:13px;">Кодът е валиден 15 минути. Ако не си заявявал/а това, просто игнорирай този имейл.</p>
          </div>
        `
      }, {
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      console.log(`✉️ [EMAIL SENT] Security code delivered to ${email} via Resend.`);
      return { success: true };
    } catch (err) {
      // A real send failure (bad API key, unverified sender/domain, Resend
      // outage) shouldn't silently strand the user with a code that was
      // never actually delivered — surface it as a normal error rather than
      // pretending it worked.
      const detail = err.response?.data?.message || err.message;
      console.error(`❌ [EMAIL SEND FAILED] ${email}:`, detail);
      const error = new Error('Неуспешно изпращане на имейл. Моля, опитайте отново след малко.');
      error.statusCode = 502;
      throw error;
    }
  }

  // On the hosted service the code must NEVER be handed back to the caller: if the e-mail key were ever missing,
  // anyone could "verify" an address they do not own and reset any account's password by reading the code from
  // the API response. Refuse instead.
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    console.error('❌ [EMAIL] RESEND_API_KEY is not configured on the production service — security codes cannot be sent.');
    const error = new Error('Изпращането на имейли временно не работи. Опитай отново по-късно.');
    error.statusCode = 503;
    throw error;
  }

  console.log(`\n======================================================`);
  console.log(`✉️ [EMAIL SECURITY CODE — DEV MODE, NOT ACTUALLY EMAILED] To: ${email}`);
  console.log(`🔑 Subject: ${subject}`);
  console.log(`🔢 6-DIGIT CODE: >>> ${code} <<< (Valid for 15 minutes)`);
  console.log(`📌 Purpose: ${purpose}`);
  console.log(`======================================================\n`);

  return {
    success: true,
    simulatedCode: code
  };
}

/**
 * Step 1 of Registration: Validate data, hash password, generate & send 6-digit email code
 */
export async function startRegistration(email, password, phone = '', ip = null) {
  const cleanEmail = email.trim().toLowerCase();

  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('Моля, въведете валиден имейл адрес.');
  }

  const passCheck = validatePasswordStrength(password);
  if (!passCheck.valid) {
    throw new Error(passCheck.message);
  }

  // At most 10 accounts a day from one network address (see utils/signupLimit.js) — refused before any e-mail is sent.
  await assertIpMayCreateAccount(ip);

  // Check if user already exists
  const dbCheck = await query(`SELECT id, is_verified FROM users WHERE LOWER(email) = LOWER($1)`, [cleanEmail]);
  const existingUser = dbCheck && dbCheck.rows
    ? dbCheck.rows.find((u) => u.is_verified !== false)
    : inMemoryDB.users.find((u) => u.email && u.email.toLowerCase() === cleanEmail && u.is_verified !== false);
  if (existingUser) {
    throw new Error('Вече съществува регистриран профил с този имейл адрес.');
  }

  checkCodeRequestCooldown('registration', cleanEmail);

  const { hash, salt } = hashPassword(password);
  const code = generate6DigitCode();
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

  pendingCodes.set(cleanEmail, {
    code,
    hash,
    salt,
    phone,
    expiresAt,
    type: 'registration'
  });

  const sendResult = await sendEmailSecurityCode(
    cleanEmail,
    code,
    'СпаркСтоп — Код за потвърждение на регистрация',
    'Потвърждение на нов акаунт'
  );

  return {
    success: true,
    message: `Изпратихме 6-цифрен код за сигурност на ${cleanEmail}.`,
    simulatedCode: sendResult.simulatedCode
  };
}

/**
 * Step 2 of Registration: Verify 6-digit code and create user profile
 */
/**
 * "Send the code again" for a registration that is already started. Keeps the password (and phone) the person
 * typed in the form: the old client called startRegistration() again with a fixed placeholder password, which
 * replaced the stored hash — an account verified after pressing "resend" was created with "DummyPassword123"
 * and its owner could not log in with the password they had chosen.
 */
export async function resendRegistrationCode(email) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const pending = pendingCodes.get(cleanEmail);
  if (!pending || pending.type !== 'registration') {
    throw new Error('Няма чакаща регистрация за този имейл. Моля, започнете отново.');
  }

  checkCodeRequestCooldown('registration', cleanEmail);

  pending.code = generate6DigitCode();
  pending.expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

  const sendResult = await sendEmailSecurityCode(
    cleanEmail,
    pending.code,
    'СпаркСтоп — Код за потвърждение на регистрация',
    'Потвърждение на нов акаунт'
  );

  return {
    success: true,
    message: `Изпратихме нов 6-цифрен код на ${cleanEmail}.`,
    simulatedCode: sendResult.simulatedCode
  };
}

export async function verifyRegistration(email, code, ip = null) {
  const cleanEmail = email.trim().toLowerCase();
  const cleanCode = code.toString().trim();

  checkNotRateLimited('reg-verify', cleanEmail);

  const pending = pendingCodes.get(cleanEmail);
  if (!pending || pending.type !== 'registration') {
    throw new Error('Няма чакаща регистрация за този имейл или кодът е изтекъл. Моля, започнете отново.');
  }

  if (Date.now() > pending.expiresAt) {
    pendingCodes.delete(cleanEmail);
    throw new Error('Кодът за сигурност е изтекъл. Моля, заявете нов код.');
  }

  if (pending.code !== cleanCode) {
    recordFailedAttempt('reg-verify', cleanEmail);
    throw new Error('Невалиден код за потвърждение. Моля, проверете и опитайте отново.');
  }
  clearAttempts('reg-verify', cleanEmail);

  // Checked again here (not only when the code was requested): ten requests could have been started before the
  // first was confirmed.
  await assertIpMayCreateAccount(ip);

  // Code is valid! Create / activate user
  let user;
  const dbFind = await query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [cleanEmail]);
  if (dbFind && dbFind.rows) {
    if (dbFind.rows[0]) {
      const dbUpdate = await query(
        `UPDATE users SET password_hash = $1, password_salt = $2, is_verified = true, phone = COALESCE(NULLIF($3, ''), phone) WHERE id = $4 RETURNING *`,
        [pending.hash, pending.salt, pending.phone || '', dbFind.rows[0].id]
      );
      user = dbUpdate.rows[0];
    } else {
      const dbInsert = await query(
        `INSERT INTO users (email, phone, password_hash, password_salt, is_verified) VALUES ($1, $2, $3, $4, true) RETURNING *`,
        [cleanEmail, pending.phone || null, pending.hash, pending.salt]
      );
      user = dbInsert.rows[0];
    }
  } else {
    user = inMemoryDB.users.find(u => u.email && u.email.toLowerCase() === cleanEmail);
    if (user) {
      user.password_hash = pending.hash;
      user.password_salt = pending.salt;
      user.is_verified = true;
      user.updated_at = new Date().toISOString();
    } else {
      user = {
        id: `user-${crypto.randomUUID()}`,
        email: cleanEmail,
        phone: pending.phone || '',
        password_hash: pending.hash,
        password_salt: pending.salt,
        is_verified: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      inMemoryDB.users.push(user);
    }
    persistLocalDB();
  }

  pendingCodes.delete(cleanEmail);
  recordLogin();
  await recordAccountCreated(ip);

  const token = generateAuthToken(user);
  return {
    success: true,
    message: 'Акаунтът е успешно потвърден и активиран!',
    user: sanitizeUser(user),
    token
  };
}

/**
 * Login user with email & password
 */
export async function loginUser(email, password) {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !password) {
    throw new Error('Моля, въведете имейл и парола.');
  }

  checkNotRateLimited('login', cleanEmail);

  const dbResult = await query(`SELECT * FROM users WHERE LOWER(email) = LOWER($1)`, [cleanEmail]);
  const user = dbResult && dbResult.rows
    ? dbResult.rows[0]
    : inMemoryDB.users.find(u => u.email && u.email.toLowerCase() === cleanEmail);
  if (!user || !user.password_hash || !user.password_salt) {
    recordFailedAttempt('login', cleanEmail);
    // Distinct from the wrong-password case below — an account that was
    // never created or has since been deleted deserves a message that
    // actually orients the user (register instead of endlessly retrying a
    // password), not the same generic wording used for a real account with
    // a mistyped password.
    throw new Error('Акаунтът не съществува или е бил премахнат.');
  }

  if (user.is_verified === false) {
    throw new Error('Акаунтът все още не е потвърден. Моля, въведете кода от имейла си.');
  }

  const isValid = verifyPassword(password, user.password_hash, user.password_salt);
  if (!isValid) {
    recordFailedAttempt('login', cleanEmail);
    throw new Error('Грешен имейл или парола.');
  }
  clearAttempts('login', cleanEmail);
  recordLogin();

  const token = generateAuthToken(user);
  return {
    success: true,
    message: 'Успешен вход!',
    user: sanitizeUser(user),
    token
  };
}

/**
 * Step 1 of Forgot Password: Send 6-digit reset code
 */
export async function startForgotPassword(email) {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) {
    throw new Error('Моля, въведете имейл адрес.');
  }

  // Applied unconditionally, before the account lookup below — if it only
  // fired for real accounts, a 429 vs. the generic success response would
  // itself become a way to enumerate which emails are registered.
  checkCodeRequestCooldown('reset', cleanEmail);

  // Deliberately identical response whether or not the account exists — a
  // distinct "no such account" error here would let anyone probe this
  // endpoint to find out which emails have СпаркСтоп accounts. Only a real
  // account actually gets a pendingCodes entry (and thus a code that can
  // ever succeed at step 2); a non-existent one just reaches a dead end
  // silently, same as GitHub/Google's reset flow.
  const dbResult = await query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [cleanEmail]);
  const user = dbResult && dbResult.rows
    ? dbResult.rows[0]
    : inMemoryDB.users.find(u => u.email && u.email.toLowerCase() === cleanEmail);
  const genericResult = {
    success: true,
    message: `Ако има регистриран акаунт с ${cleanEmail}, изпратихме 6-цифрен код за възстановяване.`
  };

  if (!user) {
    return genericResult;
  }

  const code = generate6DigitCode();
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

  pendingCodes.set(cleanEmail, {
    code,
    userId: user.id,
    expiresAt,
    type: 'reset'
  });

  const sendResult = await sendEmailSecurityCode(
    cleanEmail,
    code,
    'СпаркСтоп — Възстановяване на забравена парола',
    'Смяна на парола'
  );

  return {
    ...genericResult,
    simulatedCode: sendResult.simulatedCode
  };
}

/**
 * Step 2 of Forgot Password: Verify code and set new password
 */
export async function resetPasswordWithCode(email, code, newPassword) {
  const cleanEmail = email.trim().toLowerCase();
  const cleanCode = code.toString().trim();

  const passCheck = validatePasswordStrength(newPassword);
  if (!passCheck.valid) {
    throw new Error(passCheck.message);
  }

  checkNotRateLimited('reset-verify', cleanEmail);

  const pending = pendingCodes.get(cleanEmail);
  if (!pending || pending.type !== 'reset') {
    throw new Error('Няма активна заявка за възстановяване или кодът е изтекъл. Моля, заявете нов код.');
  }

  if (Date.now() > pending.expiresAt) {
    pendingCodes.delete(cleanEmail);
    throw new Error('Кодът за възстановяване е изтекъл. Моля, заявете нов.');
  }

  if (pending.code !== cleanCode) {
    recordFailedAttempt('reset-verify', cleanEmail);
    throw new Error('Невалиден код за сигурност. Проверете кода и опитайте отново.');
  }
  clearAttempts('reset-verify', cleanEmail);

  const { hash, salt } = hashPassword(newPassword);
  let user;
  const dbFind = await query(`SELECT id FROM users WHERE id = $1 OR LOWER(email) = LOWER($2)`, [pending.userId, cleanEmail]);
  if (dbFind && dbFind.rows) {
    if (!dbFind.rows[0]) {
      throw new Error('Потребителят не беше намерен.');
    }
    const dbUpdate = await query(
      `UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3 RETURNING *`,
      [hash, salt, dbFind.rows[0].id]
    );
    user = dbUpdate.rows[0];
  } else {
    user = inMemoryDB.users.find(u => u.id === pending.userId || (u.email && u.email.toLowerCase() === cleanEmail));
    if (!user) {
      throw new Error('Потребителят не беше намерен.');
    }
    user.password_hash = hash;
    user.password_salt = salt;
    user.updated_at = new Date().toISOString();
    persistLocalDB();
  }

  pendingCodes.delete(cleanEmail);

  const token = generateAuthToken(user);
  return {
    success: true,
    message: 'Паролата беше успешно сменена! Вече можете да влезете с нея.',
    user: sanitizeUser(user),
    token
  };
}

/**
 * Simple signed session token
 */
export function generateAuthToken(user) {
  const payload = {
    userId: user.id,
    email: user.email,
    timestamp: Date.now()
  };
  const str = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', SESSION_SECRET)
    .update(str)
    .digest('hex');
  return `${Buffer.from(str).toString('base64')}.${signature}`;
}

/**
 * True if the given id belongs to a real registered account (a row in
 * users), as opposed to a guest device id that only ever appears as a
 * saved_addresses.user_id. Used to decide whether a request for someone's
 * saved addresses needs a matching session token — a guest id can't have
 * one (there's no account to log into), so gating on "is this actually a
 * registered account" is the correct check in both SQL and in-memory mode,
 * unlike guessing from the id's string shape (in-memory ids happen to be
 * prefixed "user-", but a real Postgres UUID from gen_random_uuid() never
 * is, which silently skipped the ownership check entirely once SQL mode
 * was wired up).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function isRegisteredUserId(userId) {
  if (!userId) return false;
  // users.id is a native UUID column in SQL mode — comparing it to a
  // non-UUID-shaped string (any guest device id) throws a Postgres type
  // error rather than just matching zero rows, which crashed every guest
  // address request once real SQL was wired up. A guest id can never be a
  // real account id anyway, so skip the query entirely for anything that
  // isn't UUID-shaped.
  if (!UUID_RE.test(userId)) return false;
  const dbResult = await query(`SELECT id FROM users WHERE id = $1`, [userId]);
  if (dbResult && dbResult.rows) {
    return dbResult.rows.length > 0;
  }
  return inMemoryDB.users.some(u => u.id === userId);
}

/**
 * Looks up a user's public profile fields by id — used by GET /api/auth/me
 * (called on every page load for a logged-in user to refresh their cached
 * profile). This only ever checked inMemoryDB.users, which meant it 404'd
 * for every real SQL-mode account once the Postgres migration landed (their
 * row lives in the users table, never in inMemoryDB) — silently breaking
 * profile refresh for every real registered user site-wide.
 */
export async function getUserById(userId) {
  if (!userId) return null;
  if (UUID_RE.test(userId)) {
    const dbResult = await query(
      `SELECT id, email, phone, created_at FROM users WHERE id = $1`,
      [userId]
    );
    if (dbResult && dbResult.rows) {
      return dbResult.rows[0] || null;
    }
  }
  return inMemoryDB.users.find((u) => u.id === userId) || null;
}

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — sessions on shared/borrowed devices expire on their own

export function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  try {
    const jsonStr = Buffer.from(parts[0], 'base64').toString('utf-8');
    const expectedSig = crypto.createHmac('sha256', SESSION_SECRET)
      .update(jsonStr)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSig, 'hex');
    const givenBuf = Buffer.from(parts[1], 'hex');
    if (expectedBuf.length !== givenBuf.length || !crypto.timingSafeEqual(expectedBuf, givenBuf)) {
      return null;
    }
    const payload = JSON.parse(jsonStr);

    if (!payload.timestamp || Date.now() - payload.timestamp > SESSION_MAX_AGE_MS) {
      return null;
    }
    return payload;
  } catch (e) {
    return null;
  }
}

function sanitizeUser(user) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone || '',
    created_at: user.created_at
  };
}

export async function deleteUserAccount(userId) {
  // saved_addresses.user_id isn't a foreign key (see schema.sql — it also
  // holds guest device ids, which never have a users row), so there's no
  // ON DELETE CASCADE to rely on; delete both explicitly.
  const dbResult = await query(`DELETE FROM users WHERE id = $1 RETURNING id`, [userId]);
  if (dbResult && dbResult.rows) {
    if (dbResult.rows.length === 0) {
      throw new Error('Потребителят не е намерен.');
    }
    await query(`DELETE FROM saved_addresses WHERE user_id = $1`, [userId]);
    return { success: true, message: 'Акаунтът и всички свързани данни бяха успешно изтрити.' };
  }

  const userIdx = inMemoryDB.users.findIndex(u => u.id === userId);
  if (userIdx === -1) {
    throw new Error('Потребителят не е намерен.');
  }

  // Remove all addresses belonging to this user
  inMemoryDB.saved_addresses = inMemoryDB.saved_addresses.filter(a => a.user_id !== userId);

  // Remove the user
  inMemoryDB.users.splice(userIdx, 1);
  persistLocalDB();

  return { success: true, message: 'Акаунтът и всички свързани данни бяха успешно изтрити.' };
}
