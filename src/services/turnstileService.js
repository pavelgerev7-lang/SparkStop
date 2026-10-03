import axios from 'axios';

// Cloudflare Turnstile (the invisible "are you human" check) for the registration form. Entirely switched
// on by the two environment variables TURNSTILE_SITE_KEY (public, goes to the browser) and TURNSTILE_SECRET_KEY
// (private, verifies the answer). With either missing nothing changes: no widget is shown and nothing is verified.
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function isTurnstileEnabled() {
  return !!(process.env.TURNSTILE_SECRET_KEY && process.env.TURNSTILE_SITE_KEY);
}

export function getTurnstileSiteKey() {
  return isTurnstileEnabled() ? process.env.TURNSTILE_SITE_KEY : '';
}

/**
 * { ok } — whether the request may go on. A missing / wrong token is refused. If Cloudflare's verification
 * service itself cannot be reached the request is let through (and logged): a Cloudflare outage must not lock
 * every new user out, and the per-IP limits and the e-mailed code still apply either way.
 */
export async function verifyTurnstileToken(token, remoteIp = '') {
  if (!isTurnstileEnabled()) return { ok: true, skipped: true };
  if (typeof token !== 'string' || !token || token.length > 2048) return { ok: false, reason: 'missing' };
  try {
    const body = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    const res = await axios.post(VERIFY_URL, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 5000
    });
    return res.data && res.data.success === true
      ? { ok: true }
      : { ok: false, reason: 'rejected', codes: res.data && res.data['error-codes'] };
  } catch (err) {
    console.warn('⚠️ [TURNSTILE] verification service unreachable — letting the request through:', err.message);
    return { ok: true, unreachable: true };
  }
}
