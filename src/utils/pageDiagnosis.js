// Explains why a provider page that was fetched fine (HTTP 200) still yielded
// no announcements. Only called when zero items were found, and only ever
// produces a note for the admin health panel — it never changes what gets
// scraped or saved.
//
// It replaces a keyword scan of the first 3,000 characters of raw HTML, which
// flagged perfectly healthy pages: Топлофикация Габрово's 127 KB news page was
// reported as "blocked" only because its contact form loads Google reCAPTCHA
// (the word "captcha" sits in a <script src>). Challenge/error wording is now
// looked for in the page's VISIBLE text and only on pages small enough to be a
// challenge or error page in the first place.

function visibleText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first words of a page's visible text — recorded (as an informational note)
 * when a provider that normally has announcements returns none and the page
 * doesn't look like any known refusal, so that what the server actually receives
 * can be read back later instead of guessed at.
 */
export function pageSnippet(html, max = 140) {
  return visibleText(html).slice(0, max);
}

const PARKED_REDIRECT_RE = /location(?:\.href)?\s*=\s*["']\/lander/i;
const PARKED_TEXT_RE = /domain (?:name )?(?:is |may be )?for sale|buy this domain|this domain (?:has expired|is parked)|parked (?:free|domain)|домейнът е (?:паркиран|изтекъл|продава)/i;
const SERVER_ERROR_RE = /fatal error|parse error|uncaught (?:type|value|argument)?\s*error|stack trace|on line \d+|internal server error|service unavailable|bad gateway|gateway time-?out|application error|mysqli?_|pdoexception|sqlstate/i;
const CHALLENGE_RE = /just a moment|attention required|access denied|request blocked|you have been blocked|has been blocked|imunify360|bot protection|checking your browser|security check|verify you are (?:a )?human|enable javascript and cookies|captcha|проверка за сигурност|достъпът е отказан/i;

/**
 * @param {{status?: number, bytes?: number, title?: string, html?: string}} page
 * @returns {{kind: 'parked'|'server-error'|'bot-protection'|'tiny', note: string} | null}
 *   null = the page looks like a normal page that simply has no announcements.
 */
export function diagnoseEmptyPage({ status = 200, bytes = 0, title = '', html = '' } = {}) {
  const raw = String(html || '');
  const text = visibleText(raw);
  const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim();

  // 1. Expired / parked domain — the site itself no longer exists.
  if (bytes < 4000 && (PARKED_REDIRECT_RE.test(raw) || PARKED_TEXT_RE.test(text))) {
    return {
      kind: 'parked',
      note: `домейнът на сайта е изтекъл/паркиран — източникът вече не съществува (HTTP ${status}, ${bytes} B)`
    };
  }

  // 2. The provider's own site is crashing (PHP fatal error, 500 page served
  // with a 200, ...) — not a block, nothing on our side to fix.
  if (text.length < 4000 && SERVER_ERROR_RE.test(text.slice(0, 2000))) {
    return {
      kind: 'server-error',
      note: `сайтът им връща собствена сървърна грешка (не е блокада) — проблемът е при доставчика: "${text.slice(0, 90)}"`
    };
  }

  // 3. A firewall/bot-protection challenge page — small, with challenge wording.
  if (text.length < 3000 && CHALLENGE_RE.test(`${cleanTitle} ${text}`)) {
    return {
      kind: 'bot-protection',
      note: `защита срещу ботове: страницата е проверка/блокада (HTTP ${status}, ${bytes} B, заглавие "${cleanTitle.slice(0, 60)}")`
    };
  }

  // 4. Nearly empty — no cause we can name.
  if (bytes < 1200) {
    return {
      kind: 'tiny',
      note: `празна страница (HTTP ${status}, ${bytes} B) — вероятно блокада или повреден сайт`
    };
  }

  return null;
}
