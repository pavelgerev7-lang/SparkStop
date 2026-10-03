import {
  startRegistration,
  resendRegistrationCode,
  verifyRegistration,
  loginUser,
  startForgotPassword,
  resetPasswordWithCode,
  verifyAuthToken,
  deleteUserAccount,
  getUserById
} from '../services/authService.js';
import { verifyTurnstileToken } from '../services/turnstileService.js';
import { formBotReason } from '../utils/botTrap.js';
import { recordBotStrike, STRIKE } from '../utils/botBan.js';
import { clientKey } from '../utils/clientKey.js';

// A JSON body can carry anything (a number, an object, null): fields the services call .trim() on are coerced to
// strings first, so a bad body gets the normal Bulgarian validation message instead of a JavaScript TypeError.
const str = (v) => (typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : ''));

const BOT_REFUSED = 'Не успяхме да потвърдим, че не си робот. Обнови страницата и опитай пак.';

/**
 * Bots are stopped before a code e-mail is sent (each one costs mail quota and can be aimed at a third party's
 * address): first the free traps (hidden field, instant submit), then the Turnstile check, which does nothing
 * until its keys are set. Sends the 400 itself and returns true when the request was refused.
 */
async function refuseBot(req, res) {
  const body = req.body || {};
  const trap = formBotReason(body);
  const human = trap
    ? { ok: false }
    : await verifyTurnstileToken(body.turnstileToken, String(req.headers['cf-connecting-ip'] || req.ip || '').split(',')[0].trim());
  if (human.ok) return false;
  // Strikes toward a one-hour block of this address from the e-mail forms (see utils/botBan.js).
  const strike = recordBotStrike(clientKey(req), trap === 'honeypot' ? STRIKE.HONEYPOT : (trap === 'too-fast' ? STRIKE.TOO_FAST : STRIKE.TURNSTILE));
  if (trap) console.warn(`🤖 [BOT TRAP] ${trap} on ${req.path}${strike.justBanned ? ' — address blocked for 1 h' : ''}`);
  else if (strike.justBanned) console.warn(`🤖 [BOT TRAP] repeated failed human checks on ${req.path} — address blocked for 1 h`);
  res.status(400).json({ success: false, message: BOT_REFUSED });
  return true;
}

export async function registerHandler(req, res) {
  try {
    if (await refuseBot(req, res)) return;
    const { email, password, phone } = req.body || {};
    const result = await startRegistration(str(email), str(password), str(phone), clientKey(req));
    return res.status(200).json({
      success: true,
      message: result.message,
      simulatedCode: result.simulatedCode // friendly helper for UI demonstration
    });
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * POST /api/auth/resend-code — a new code for a registration that is already started (keeps the chosen password).
 */
export async function resendRegistrationCodeHandler(req, res) {
  try {
    const result = await resendRegistrationCode(str((req.body || {}).email));
    return res.status(200).json({
      success: true,
      message: result.message,
      simulatedCode: result.simulatedCode
    });
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * POST /api/auth/verify-registration
 */
export async function verifyRegistrationHandler(req, res) {
  try {
    const { email, code } = req.body || {};
    const result = await verifyRegistration(str(email), str(code), clientKey(req));
    return res.status(200).json({
      success: true,
      message: result.message,
      data: {
        user: result.user,
        token: result.token
      }
    });
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * POST /api/auth/login
 */
export async function loginHandler(req, res) {
  try {
    const { email, password } = req.body || {};
    const result = await loginUser(str(email), str(password));
    return res.status(200).json({
      success: true,
      message: result.message,
      data: {
        user: result.user,
        token: result.token
      }
    });
  } catch (error) {
    return res.status(error.statusCode || 401).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * POST /api/auth/forgot-password
 */
export async function forgotPasswordHandler(req, res) {
  try {
    if (await refuseBot(req, res)) return;
    const { email } = req.body || {};
    const result = await startForgotPassword(str(email));
    return res.status(200).json({
      success: true,
      message: result.message,
      simulatedCode: result.simulatedCode
    });
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * POST /api/auth/reset-password
 */
export async function resetPasswordHandler(req, res) {
  try {
    const { email, code, newPassword } = req.body || {};
    const result = await resetPasswordWithCode(str(email), str(code), str(newPassword));
    return res.status(200).json({
      success: true,
      message: result.message,
      data: {
        user: result.user,
        token: result.token
      }
    });
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * GET /api/auth/me
 */
export async function getMeHandler(req, res) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const session = verifyAuthToken(token);

    if (!session || !session.userId) {
      return res.status(401).json({ success: false, message: 'Невалидна сесия.' });
    }

    const user = await getUserById(session.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Потребителят не е намерен.' });
    }

    return res.status(200).json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        phone: user.phone || '',
        created_at: user.created_at
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

/**
 * DELETE /api/auth/delete-account
 */
export async function deleteAccountHandler(req, res) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const session = verifyAuthToken(token);

    if (!session || !session.userId) {
      return res.status(401).json({ success: false, message: 'Невалидна сесия.' });
    }

    const result = await deleteUserAccount(session.userId);
    return res.status(200).json({
      success: true,
      message: result.message
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }
}
