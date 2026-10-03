// Shared by all three scrape strategies (A/B/C) in scraperService.js to
// decide whether a scraped fragment is even worth considering as a
// candidate outage item — kept here as ONE function (not three near-
// identical copies) specifically so a fix like this doesn't have to be
// re-applied three separate times and risk drifting out of sync, the same
// reasoning already applied to isAnnouncementIndicatingNoOutage below.
// "ток" (electricity/current) is the one 3-letter keyword in this list —
// short enough to appear as a bare substring inside ordinary, unrelated
// words ("изток" = east, "поток" = stream, both common as literal district/
// place names in real bulletins), the exact same collision class already
// confirmed live for "ул "/"с. " in isAnnouncementIndicatingNoOutage and for
// "ул" in extractStreetsHeuristic. Only the LEFT side needs a Cyrillic-safe
// boundary (rejects "изТОК"/поТОК, both preceded by a letter) — the right
// side is deliberately left open, same as "прекъс"/"авари" below, so this
// still matches "ток", "тока", "токът", "токов" (real inflections of the
// word this keyword means to catch), not just the bare dictionary form.
const TOK_KEYWORD_RE = /(?:^|[^а-я])ток/i;

export function containsOutageIndicatorKeyword(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes('авари') || lower.includes('ремонт') || lower.includes('спиране') || lower.includes('спрян')
    || lower.includes('водоподаване') || lower.includes('прекъс') || lower.includes('преустанов') || TOK_KEYWORD_RE.test(lower);
}

/**
 * Cleans Bulgarian utility outage text by stripping repetitive boilerplate,
 * footer company descriptions, navigation breadcrumbs, and duplicates.
 *
 * @param {string} text - Raw uncleaned announcement text
 * @returns {string} Clean, crisp operative outage text
 */
export function cleanOutageAnnouncementText(text) {
  if (!text || typeof text !== 'string') return '';

  let cleaned = text.replace(/\s+/g, ' ').trim();

  // 1. Strip publishing metadata timestamps, news tags, and author badges
  cleaned = cleaned.replace(/Публикуван[оаеи]\s*(?:на|в|от)?\s*[\d.:/\s-]+/gi, '');
  cleaned = cleaned.replace(/Дата\s+на\s+публикуване:?[\s\S]*?(?=[.!?\n]|$)/gi, '');
  cleaned = cleaned.replace(/Новини\s+от\s+ВиК[\s\S]*?(?=[.!?\n]|$)/gi, '');
  cleaned = cleaned.replace(/Съобщение\s*\(от\s+ВиК[\s\S]*?\):?/gi, '');
  // The near-universal opening of a small municipal ВиК/utility bulletin:
  // '"[Company name]" ООД, гр. [ProviderHomeTown] уведомява своите
  // абонати, че ...'. Confirmed live this became a real regression the
  // moment extractStreetsHeuristic() (aiParserService.js) learned to
  // recognize a bare "гр." prefix (needed separately, to stop losing
  // bulletins whose ONLY location detail is "гр. X" with no street) — every
  // one of THESE openers also starts with "гр. [ProviderHomeTown]", so it
  // started tagging the company's own home-town address as an affected
  // location on literally every bulletin from providers using this
  // template, alongside the real one. NOT bounded to end-of-sentence (like
  // the footer strips above are) — the real outage detail almost always
  // continues in the very same sentence right after "уведомява своите
  // абонати, че...", so only the boilerplate span itself is removed.
  cleaned = cleaned.replace(/["„”“'][^"„”“']{2,60}["„”“']\s*(?:ООД|ЕООД)\s*,\s*гр\.\s*[А-Я][а-я]+(?:\s+[А-Я][а-я]+)?\s+уведомява\s+своите\s+абонати,?\s*(?:че)?\s*/i, '');
  cleaned = cleaned.replace(/Автор:?[\s\S]*?(?=[.!?\n]|$)/gi, '');
  cleaned = cleaned.replace(/Категория:?[\s\S]*?(?=[.!?\n]|$)/gi, '');

  // 2. Remove company footer boilerplate (e.g. list of all municipalities served).
  // Bounded to the current sentence (same [\s\S]*?(?=[.!?\n]|$) pattern already
  // used above for "Автор:"/"Категория:"), NOT to the end of the whole string —
  // these trigger phrases can appear mid-text with the actual outage details
  // (street, time window) sitting in a LATER sentence of the same announcement,
  // and a "$"-anchored match was deleting that real content along with the
  // boilerplate. Costs a little leftover footer noise reaching the AI parser
  // in exchange for never deleting the one sentence that actually matters.
  cleaned = cleaned.replace(/„?[^.]*?осъществява дейностите по експлоатация[\s\S]*?(?=[.!?\n]|$)/i, '');
  cleaned = cleaned.replace(/„?[^.]*?предоставяне на услугите доставяне на питейна вода[\s\S]*?(?=[.!?\n]|$)/i, '');
  // A third-party accessibility-widget plugin (common on many Bulgarian
  // WordPress sites, e.g. Топлофикация Перник) injects this exact English
  // WCAG boilerplate paragraph into every page it's installed on — confirmed
  // live: it got scooped up by the broad `p, .content, .entry-content,
  // article` body selector and appended after a real, otherwise-clean
  // outage announcement, over 2000 characters of unrelated English text
  // about screen readers tacked onto the end. Unlike the sentence-bounded
  // strips above, this one is safe to cut to the true end of the string —
  // confirmed live it only ever appears as the LAST thing on the page (the
  // site's own footer), never followed by real content.
  cleaned = cleaned.replace(/We firmly believe that the internet should be available[\s\S]*$/i, '').trim();
  // The company's own footer glued to the end of the announcement carries ITS address and
  // phone ("ЕИК: 126004284 … гр. Хасково, ул. „Сакар“ №2 …", "Габрово, бул. “Трети март” № 6,
  // Денонощен телефон за аварии …", a cookie banner) — read as affected streets: a
  // "ул. Сакар" and a "бул. Трети март" were put on the map for outages elsewhere. Only cut when
  // real content precedes the marker.
  const footerAt = cleaned.search(/(?:ЕИК\s*:|Денонощен\s+телефон|Този\s+сайт\s+използва\s+бисквитки|Дизайн\s+и\s+разработка|©)/i);
  if (footerAt > 60) {
    cleaned = cleaned.slice(0, footerAt).trim();
    // …and the company address that sits right before the phone line ("Габрово, бул. “Трети март” № 6,").
    cleaned = cleaned.replace(/(?:^|(?<=[.!?]\s))(?:гр\.\s*)?[А-Я][а-я]+,\s*(?:ул|бул)\.\s*[^,.]{1,40}?№\s*\d+[А-Яа-я]?\s*,?\s*$/, '').trim();
  }
  // "Назад" ("Back", a nav-link label) is ALSO ordinary Bulgarian for "ago" —
  // e.g. "регистрирана преди половин час назад, а ремонтът... ще приключи в
  // 17:30" has the real content in the SAME sentence right after the word,
  // so bounding to sentence-end (like the others above) doesn't help here;
  // the only safe fix is to not strip on this word at all.
  cleaned = cleaned.replace(/Община\s+Велико\s+Търново,\s*Община\s+Горна\s+Оряховица[\s\S]*?(?=[.!?\n]|$)/i, '');
  cleaned = cleaned.replace(/Всички\s+права\s+запазени[\s\S]*?(?=[.!?\n]|$)/i, '');
  cleaned = cleaned.replace(/Политика\s+за\s+поверителност[\s\S]*?(?=[.!?\n]|$)/i, '');

  // 3. Split into sentences and deduplicate
  // The naive split below treats ANY ".<space>" as a sentence end, which
  // breaks on abbreviations like "бл." (block) sitting right before a
  // number — confirmed live: "...от бл. 422 до бл. 424. След приключване..."
  // split into a fragment ending "...до бл." and a SEPARATE "424." fragment;
  // "424." is only 4 characters, so it failed the length>8 filter below and
  // silently vanished from the final text, truncating the real range
  // ("бл. 422 до бл. 424") down to just "бл. 422" downstream. Protecting the
  // space after these abbreviations (when followed by a digit — the one
  // shape a real sentence essentially never takes right after one of these)
  // stops it splitting there at all, without touching genuine sentence ends.
  // \b doesn't work as a boundary before Cyrillic letters (JS \w is
  // ASCII-only) — same reason isAnnouncementIndicatingNoOutage() below uses
  // (?:^|[^а-яa-z]) instead of \b for its own street-marker check.
  const ABBREV_PROTECT_RE = /((?:^|[^а-яa-z])(?:бл|ул|бул|кв|пл|№))\.\s+(?=\d)/gi;
  // The same split also cut "с. Телериг." into "…на: с." + "Телериг." — and a
  // fragment of 8 characters or fewer is thrown away below, so the LAST village of
  // a ЕРП Север bulletin (any name of 7 letters or fewer: Красен, Ясени, Наум,
  // Опанец…) vanished from the text, and a bulletin with only that village fell
  // back to the generic "Централна градска част". A settlement/street prefix
  // followed by its name is never a sentence end, whatever the name starts with.
  const TYPED_PREFIX_PROTECT_RE = /((?:^|[^а-яa-z])(?:с|гр|ул|бул|кв|пл|жк|ж\.к|м-ст|м-т|св|ген))\.\s+(?=[а-яА-Яa-zA-Z«„"“])/gi;
  // "до 23. 09. 2026г." (a date written with spaces after the dots, ВиК Добрич) is one
  // date, not three sentences: the middle piece "09." is 3 characters and was dropped,
  // leaving "до 23. 2026г." — which the time parser then read as "until 23:00".
  const SPACED_DATE_PROTECT_RE = /(?<!\d)(\d{1,2}\.)\s+(?=\d{1,2}\.\s*\d{4})|(?<!\d)(\d{1,2}\.\d{1,2}\.)\s+(?=\d{4})/g;
  const NOSPLIT_TOKEN = '@@NOSPLIT@@';
  const protectedText = cleaned
    .replace(ABBREV_PROTECT_RE, (_, prefix) => `${prefix}.${NOSPLIT_TOKEN}`)
    .replace(TYPED_PREFIX_PROTECT_RE, (_, prefix) => `${prefix}.${NOSPLIT_TOKEN}`)
    .replace(SPACED_DATE_PROTECT_RE, (_, a, b) => `${a || b}${NOSPLIT_TOKEN}`);
  const sentences = protectedText.split(/(?<=[.!?])\s+/).map((s) => s.split(NOSPLIT_TOKEN).join(' '));
  const seen = new Set();
  const resultSentences = [];

  for (const s of sentences) {
    const trimmed = s.trim();
    const lower = trimmed.toLowerCase();

    // Skip empty, tiny, or duplicate sentences
    if (trimmed.length > 8 && !seen.has(lower)) {
      seen.add(lower);
      resultSentences.push(trimmed);
    }
  }

  const finalOutput = resultSentences.join(' ').trim();
  return finalOutput || cleaned;
}

/**
 * Checks if announcement text indicates no outages / routine disclaimer / general phone contact
 */
export function isAnnouncementIndicatingNoOutage(text) {
  if (!text || typeof text !== 'string') return true;
  const lower = text.toLowerCase();
  // A customer-testimonial block ("Отзиви — Какво клиентите казват за нас — Доволна съм от
  // обслужването! … Отстраниха теч след ремонт на водомер", ВиК Петрич) contains the outage
  // vocabulary but is not an outage: it was saved as an "outage" that came alive every morning
  // at 08:00 (no date, so the same-day 08:00-17:00 default applied).
  if (/(?:^|[^а-я])(?:отзиви|какво\s+клиентите\s+казват|доволна\s+съм|доволен\s+съм)(?:$|[^а-я])/.test(lower)) return true;
  // Static company pages the generic selectors also scoop up (ВиК Йовковци's "Условия за
  // присъединяване 1.1. Изпълнението на всички условия …" became an "outage" dated 01.01).
  if (/условия\s+за\s+присъединяване|ценоразпис\s+на\s+услугите/.test(lower)) return true;
  // "Електропроводът е собственост на Лукойл и не захранва клиенти на ЕР Юг" (EVN) — nobody's supply is cut.
  if (/не\s+захранва\s+клиенти/.test(lower)) return true;
  // A TRAFFIC notice about works on a pipe or cable: "Авариен ремонт по подмяна на водопроводната мрежа по ул.
  // „Цар Освободител", гр. Свищов … участъкът … ще бъде ограничено за движение за МПС. Моля да не паркирате"
  // (ВиК Йовковци) says nothing about the supply being cut, yet it stood on the map as a water outage for 25 days.
  // Kept when the same text also says the supply is cut / pressure drops (a real outage that also closes the road).
  if (
    /ограничено\s+за\s+движение|ограничаване\s+на\s+движението|ограничение\s+на\s+движението|да\s+не\s+паркирате|затворена\s+за\s+движение|затваряне\s+на\s+(?:улицата|участъка)/.test(lower) &&
    !/спира|спрян|прекъсн|прекъсв|без\s+(?:вода|водоподаване|ток|електро|парно|топла|газ)|водоподаването|електрозахранването|топлоподаването|газоподаването|налягане|напор/.test(lower)
  ) return true;
  // Dots are optional in practice — real scraped text often drops them
  // ("жк Изгрев" instead of "ж.к. Изгрев") — confirmed live: a genuine
  // Berkovitsa water-outage bulletin was nearly misclassified as
  // boilerplate by this check requiring the literal dotted form.
  // Cyrillic-safe word-boundary required before each marker (JS \b doesn't
  // recognize Cyrillic letters, same reason normalizeStreetName() uses this
  // pattern) — confirmed live: bare .includes('ул ') matched inside
  // "радиомодул " (a water-meter "module", nothing to do with a street) and
  // .includes('с. ') matched inside "бизнес. " (end of an ordinary
  // sentence), each time waving a company-service/marketing announcement
  // through as if it named a real street or village.
  // "селата Щит, Пашово, Сладун" / "в кварталите …" name places just as "с. Щит" does (ВиК Хасково's
  // live outage lines were all dropped as "no street, no time").
  // "гр. Шабла - напор за къмпинг …, без водоподаване до приключване на аварията" (ВиК Добрич, a
  // real open-ended outage) names its town only as "гр." — without it here the line read as
  // "no place, no time" and the sweep resolved it every 20 minutes.
  const STREET_INDICATOR_RE = /(?:^|[^а-яa-z])(?:ул\.|ул\s|бул\.|бул\s|ж\.к\.|жк\s|кв\.|кв\s|село\s|с\.\s|гр\.\s|град\s|селата\s|селища\s|кварталите\s|улиците\s|булевардите\s)/i;
  const hasStreet = STREET_INDICATOR_RE.test(lower);

  // A real, specific outage can still contain one of these phrases as a
  // preamble/comparison clause — e.g. "Към момента няма опасност за живота
  // на хората, но водоподаването на ул. Раковски ще бъде прекъснато..." —
  // these plain substring checks used to fire on that co-occurrence and
  // discard the whole announcement before it ever reached the AI parser.
  // Same guard already used just below for the emergency-hotline check.
  if (
    !hasStreet && (
      lower.includes('няма аварийни спирания') ||
      lower.includes('няма спирания') ||
      lower.includes('няма планирани ремонти') ||
      lower.includes('няма регистрирани аварии') ||
      lower.includes('няма прекъсвания') ||
      lower.includes('без прекъсване') ||
      lower.includes('без прекъсвания') ||
      lower.includes('към момента няма') ||
      lower.includes('всички съоръжения работят нормално') ||
      lower.includes('нормално водоподаване') ||
      lower.includes('нормално газоподаване')
    )
  ) {
    return true;
  }

  // If it is just a telephone line banner without a street or time frame
  if (!hasStreet && (lower.includes('аварийна линия') || lower.includes('денонощна връзка с диспечерския') || lower.includes('обажданията към 0700'))) {
    return true;
  }

  // A homepage's own welcome banner ("Добре дошли на сайта на...") —
  // confirmed live: a provider pointed at its bare homepage got this
  // scraped as if it were an outage.
  if (lower.includes('добре дошли на сайта')) {
    return true;
  }

  // A site's own navigation chrome scraped as if it were the announcement:
  // a "Моля изберете" ("please select") dropdown label, or a "Начало /
  // Аварии / Page 2" breadcrumb trail. No real outage bulletin contains
  // either. Confirmed live: ВиК Варна's per-region page was scraped whole,
  // menu included ("...Начало ЕТР Провадия Провадия Съобщения за аварии Без
  // вода Карта на ремонтите... Моля изберете ЕТР Варна ЕТР Девня..."), giving
  // the same village/day a second, junk record next to the real one; ВиК
  // София област's archive page 2 was scraped the same way.
  if (lower.includes('моля изберете') || /(?:^|[^а-я])начало\s*\/\s*(?:аварии|планови ремонти|новини)/.test(lower)) {
    return true;
  }

  // A standing "our emergency team is ready to respond" capability
  // statement, NOT an announcement of an actual current problem — checked
  // WITHOUT the !hasStreet guard used above, since this exact pattern
  // names its service area ("...на територията на гр. Каварна и с.
  // Българево") specifically to describe WHO it serves, which is exactly
  // what defeats the street/settlement-based heuristic. Confirmed live:
  // this showed as a live red "active outage" alert for a village with no
  // real current problem at all.
  if (lower.includes('готова да реагира') || lower.includes('готови да реагираме')) {
    return true;
  }

  // Generic "About us" company/coverage-area description — real outage
  // bulletins never cite the municipality's total area or population count.
  // Checked WITHOUT the !hasStreet guard for the same reason as above: this
  // pattern names every village it serves ("...в гр. Пещера, с.Радилово,
  // с. Димитриево...") specifically to describe coverage, which is exactly
  // what defeats the street-based heuristic. Confirmed live: this showed a
  // whole municipality's population/area statistics as a "scheduled
  // outage" for those villages.
  if (lower.includes('общата площ на община') || lower.includes('общият брой на населението') || lower.includes('изпълнява следните дейности')) {
    return true;
  }

  // A business/pricing document notice, not an outage — confirmed live:
  // Водоснабдяване-Дунав's "Official proposal and price table" business
  // announcement matched the generic keyword filter (mentions the utility
  // itself) and would show as a live outage if it ever got a fresh date.
  if (lower.includes('официално предложение') || lower.includes('таблица с цените')) {
    return true;
  }

  // A "meter-reading schedule" / company services-and-contact page, not an
  // outage — confirmed live: Инфрастрой (ВиК Брацигово)'s homepage lists its
  // excavator-rental services and a water-meter reading schedule, and got
  // waved through only because it also states the COMPANY'S OWN office
  // street address ("Адрес: Гр. Брацигово, ул. ... №33"), which is exactly
  // why this is checked WITHOUT the !hasStreet guard.
  if (lower.includes('график за отчитане на водомер') || lower.includes('телефонни номера за връзка')) {
    return true;
  }

  // A company's own founding/registration history — deliberately a GENERAL
  // rule rather than matching one specific company's exact wording, so it
  // also catches whichever OTHER provider's "About us" text uses the same
  // extremely common formula in the future, not just the three confirmed
  // live so far (Газо-Енергийно Дружество Елин Пелин: "е създадено през
  // 2005 год."; Правецгаз 1: "е създадено и регистрирано съгласно
  // действащото законодателство"; Топлофикация Велико Търново: "е основано
  // през 1977 г." — this one also happens to mention a real street from its
  // own 1985 history ["...жилищен блок на ул. Габровска..."], which is
  // exactly why this whole block is checked WITHOUT the !hasStreet guard).
  // No genуине outage bulletin ever describes when/how the COMPANY ITSELF
  // was founded or licensed.
  if (lower.includes('е създадено') || lower.includes('е регистрирано') || lower.includes('получава лицензия') || lower.includes('притежаваните лицензии')
    || lower.includes('е основано') || lower.includes('е основана') || lower.includes('основано през') || lower.includes('основана през')) {
    return true;
  }

  // "научи повече тук" ("learn more here") appearing 2+ times is the
  // signature of a scraped link-LIST/index page (many different headlines
  // each followed by the same generic read-more link, concatenated
  // together) rather than one coherent announcement — confirmed live: a
  // provider's "Аварии и ремонт" listing page got scraped this way before
  // Strategy B was taught to follow each individual headline's own link.
  // ("прочети повече" was tried as a second phrasing of the same signature
  // for a different provider, then reverted — that provider's individual,
  // genuinely single-incident article pages ALSO show that phrase, in a
  // "related posts" sidebar widget scooped up by Strategy B's own broad
  // body-selector, so counting it here discarded real content along with
  // the actual index page. See the sourceUrl-vs-target.url check in
  // scraperService.js Strategy A for how that specific case is filtered
  // instead — at the SOURCE of the scrape, not after the fact here.)
  const readMoreCount = (lower.match(/научи повече тук/g) || []).length;
  if (readMoreCount >= 2) {
    return true;
  }

  // "Дата: <ден от седмицата> > <дата>" repeated 2+ times is the news-INDEX
  // signature of a different template (ВиК Пловдив) — a "Новини" list of
  // separate, unrelated announcements (a water-quality notice, a meter-
  // reading schedule, cashier office hours, a water-tanker location list)
  // each stamped with its own "Дата: Съббота > 05-Септември-2026"-style
  // header, all concatenated into one scraped blob. Confirmed live: this
  // produced ONE outage record whose "affected streets" were a mashup of
  // payment-office and water-tanker-truck addresses that have nothing to do
  // with any actual water supply interruption — currently harmless only
  // because the extracted date happened to already be in the past, but the
  // exact same page structure would show a false active/scheduled outage
  // for all of those addresses the day this listing's newest item is a
  // genuinely current one.
  const dateMarkerCount = (lower.match(/дата:\s*\S+\s*>/g) || []).length;
  if (dateMarkerCount >= 2) {
    return true;
  }

  // A genuine outage bulletin — confirmed across every real one seen this
  // session — always states an actual time window ("от 09:00 до 16:30 ч.",
  // "9:00ч. – 17:00ч.") even when it's vague about the exact street. Text
  // with neither a street NOR any time-of-day reference is essentially
  // always something else entirely: "About us" company-history paragraphs,
  // office-hours banners, generic disclaimer footers — confirmed live, this
  // caught several small-site scrapes that had grabbed exactly that kind of
  // boilerplate (e.g. a company-founding blurb, a "will notify you of any
  // changes" footer sentence) as if it were a live outage.
  // A colon-separated pair is unambiguously a time ("09:00"); a dot-separated
  // one is NOT — Bulgarian dates are written day.month ("17.09.2026"), the
  // exact same shape as a time written with a dot instead of a colon
  // ("17.30"). The dot form only counts when "ч."/"часа" sits right next to
  // it. Confirmed live: a gas company's "About us" paragraph citing its own
  // 2012 license date ("Решение №.../17.09.2012 г.") satisfied the old
  // dot-or-colon check and got treated as if it stated a real time window,
  // letting pure company-history boilerplate through as a live outage.
  const hasTimeReference = /\d{1,2}:\d{2}|\d{1,2}[:.]\d{2}\s*(?:ч\.|часа)|\d{1,2}\s*(?:ч\.|часа)/i.test(text);
  if (!hasStreet && !hasTimeReference) {
    return true;
  }

  // Bare settlement name with nothing else ("село Жижево", 12 characters) —
  // confirmed live: this passed every check above because merely NAMING a
  // village satisfies hasStreet on its own, with no requirement that any
  // actual outage description (what/when/why) follow it. Sat in the live DB
  // for weeks as an "active" outage with a start date that just kept
  // rolling forward on every re-scrape, showing a red map marker for a
  // village with zero real information behind it. Every genuine bulletin
  // seen this session — even the shortest ones — is a full sentence well
  // past this length; a real announcement without an explicit time (an
  // open-ended "until fixed" repair) still describes what's happening, so
  // this doesn't risk that case the way requiring hasTimeReference outright
  // would have.
  if (!hasTimeReference && text.trim().length < 25) {
    return true;
  }

  return false;
}

/**
 * True if the bulletin only warns that a disruption is POSSIBLE (e.g. ЕРП
 * Север's "са възможни смущения" during routine switching operations) as
 * opposed to stating the supply WILL definitely be cut ("ще бъде
 * прекъснато"/"ще бъде спряно"). Real ЕРП Север bulletins use both phrasings
 * for genuinely different things — a firm outage vs. a precautionary notice
 * that power might briefly flicker — but everything downstream (status,
 * map color, "⚠️ Активна авария!" label) previously treated them identically.
 * Checked for the DEFINITE phrasing first: a bulletin can legitimately
 * contain "възможни" earlier as a hedge/preamble while still stating a firm
 * cut later in the same text, and the firm statement should win.
 */
export function isOnlyPossibleDisruption(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();

  const statesDefiniteCut = /ще\s+б[ъе]де\s+прек[ъа]снат|ще\s+б[ъе]де\s+спр[ъе]н|ще\s+бъдат\s+прекъснати|спира(?:т|не)?\s+(?:водоподаването|електрозахранването|газоподаването|топлоподаването)/i.test(lower);
  if (statesDefiniteCut) return false;

  // "Възможни са нарушения във водоподаването поради профилактика на
  // енергопреносната мрежа" (ВиК Русе's notices for a village whose water only
  // MIGHT be affected by nearby power maintenance) is the same kind of notice.
  return /са\s+възможни\s+смущения|възможни\s+смущения\s+в|възможно\s+е\s+кратковременно|възможни\s+са\s+(?:кратковременни\s+)?(?:нарушения|смущения|прекъсвания)|са\s+възможни\s+(?:кратковременни\s+)?(?:нарушения|смущения|прекъсвания)|възможни\s+нарушения\s+(?:във|в)\s/i.test(lower);
}
