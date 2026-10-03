// Two cheap traps for the forms that send a code e-mail (registration, forgot password). They cost a real person
// nothing and catch the simple bots that fill every field they find or submit instantly:
//   - hp_contact: a field no person sees (it sits off-screen); a bot that fills every input fills it too.
//   - formElapsedMs: how long the form had been on screen, measured by the page itself (immune to a wrong clock).
// A client that sends neither (an older cached page) is not judged by them — the Turnstile check and the rate
// limits are what stop bots that never run the page.
const MIN_FILL_MS = 800;

/** 'honeypot' | 'too-fast' | null */
export function formBotReason(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.hp_contact !== undefined && b.hp_contact !== null && String(b.hp_contact).trim() !== '') return 'honeypot';
  if (typeof b.formElapsedMs === 'number' && Number.isFinite(b.formElapsedMs) && b.formElapsedMs >= 0 && b.formElapsedMs < MIN_FILL_MS) return 'too-fast';
  return null;
}
