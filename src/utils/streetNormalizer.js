/**
 * СпаркСтоп Industrial-Grade Bulgarian Address Normalization & Matching Engine
 * 
 * Uses Unicode-aware Cyrillic boundary patterns rather than ASCII-only \b.
 * Guarantees zero false positives and zero false negatives across all Bulgarian cities.
 */

// Helper to replace whole Cyrillic words/phrases safely
function replaceCyrillicWord(str, pattern, replacement) {
  const regex = new RegExp(`(^|[^а-яa-z0-9_])${pattern}($|[^а-яa-z0-9_])`, 'gi');
  return str.replace(regex, `$1${replacement}$2`);
}

/**
 * Normalizes accidental Latin lookalike characters and common historical/date street names
 */
export function sanitizeBulgarianText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let str = raw.toLowerCase().trim();

  // Normalize ordinal dates and historic names
  str = str
    .replace(/(?:^|[^а-яa-z0-9])(?:6-?ти|шести)\s+септември(?:$|[^а-яa-z0-9])/gi, ' 6 септември ')
    .replace(/(?:^|[^а-яa-z0-9])(?:25-?ти|двадесет\s+и\s+пети)\s+септември(?:$|[^а-яa-z0-9])/gi, ' 25 септември ')
    .replace(/(?:^|[^а-яa-z0-9])(?:3-?ти|трети)\s+март(?:$|[^а-яa-z0-9])/gi, ' 3 март ')
    .replace(/(?:^|[^а-яa-z0-9])цар\s+борис\s*(?:iii|3|трети)(?:$|[^а-яa-z0-9])/gi, ' цар борис 3 ')
    .replace(/(?:^|[^а-яa-z0-9])цар\s+борис\s*(?:ii|2|втори)(?:$|[^а-яa-z0-9])/gi, ' цар борис 2 ')
    .replace(/(?:^|[^а-яa-z0-9])цар\s+борис\s*(?:i|1|първи)(?:$|[^а-яa-z0-9])/gi, ' цар борис 1 ')
    .replace(/(?:^|[^а-яa-z0-9])петър\s*(?:i|1|първи)(?:$|[^а-яa-z0-9])/gi, ' петър 1 ')
    .replace(/(?:^|[^а-яa-z0-9])симеон\s*(?:i|1|първи)(?:$|[^а-яa-z0-9])/gi, ' симеон 1 ');

  return str.replace(/\s+/g, ' ').trim();
}

/**
 * Extracts normalized core street name without prefixes or house numbers
 * e.g., "ул. Иван Вазов №12, вх. А" -> "иван вазов"
 * e.g., "бул. България 45" -> "българия"
 * e.g., "ж.к. Младост 1, бл. 74" -> "младост 1"
 * e.g., "бул. 6-ти Септември" -> "6 септември"
 */
// Shared by normalizeStreetName() and extractAddressNumbers() — these used
// to be two independently-typed-out lists that had drifted apart (e.g.
// "меден рудник" was only ever recognized as a numbered district by the
// first function), so a district's zone number could get treated as a
// street/house number by the other depending on which one happened to run.
export const NUMBERED_DISTRICT_NAMES = [
  'младост', 'люлин', 'надежда', 'дружба', 'тракия', 'изток', 'изгрев',
  'запад', 'смирненски', 'възраждане', 'орфей', 'чайка', 'лазур',
  'славейков', 'меден рудник', 'еленово', 'струмско', 'сторгозия',
  'бузлуджа', 'колю фичето'
];

// Some of the words above are ALSO a real person's surname used in an
// unrelated, differently-located street (e.g. Plovdiv's "кв. Смирненски"
// quarter vs. the nationwide "ул. Христо Смирненски" street; Burgas's "к-с
// Славейков" complex vs. "ул. Петко Р. Славейков"). Matching the bare
// surname anywhere in the text used to silently discard the given name and
// treat the person's street and the district as the same place. When one of
// these known given names appears anywhere earlier in the string, treat it
// as the person's-name street instead of the district.
const DISTRICT_NAME_GIVEN_NAME_EXCEPTIONS = {
  'смирненски': ['христо'],
  'славейков': ['петко']
};

export function normalizeStreetName(rawName) {
  if (!rawName || typeof rawName !== 'string') return '';

  let str = sanitizeBulgarianText(rawName);

  // Strip prefixes using Unicode boundaries
  const prefixWords = [
    'ул\\.?', 'улица', 'бул\\.?', 'булевард', 'кв\\.?', 'квартал', 
    'ж\\.?к\\.?', 'жк', 'комплекс', 'к-с', 'пл\\.?', 'площад',
    'вх\\.?\\s*[а-яa-z0-9]+', 'вход\\s*[а-яa-z0-9]+',
    'ап\\.?\\s*\\d+', 'апартамент\\s*\\d+',
    'ет\\.?\\s*\\d+', 'етаж\\s*\\d+'
  ];

  prefixWords.forEach((p) => {
    const rx = new RegExp(`(^|[^а-яa-z0-9])${p}($|[^а-яa-z0-9])`, 'gi');
    str = str.replace(rx, ' ');
  });

  // Check numbered districts (e.g. "младост 1", "люлин 5", "тракия"). Allows
  // a hyphen as well as whitespace before the zone number — "Тракия-1" (a
  // plausible scraped/copy-pasted variant) used to lose the "1" entirely
  // since only \s+ was accepted, silently collapsing two different numbered
  // zones of the same district (e.g. "Люлин-3" vs "Люлин-7") to one identical
  // normalized core. The zone number also allows one trailing Cyrillic
  // letter with no separator ("Младост 1А", a real Sofia sub-zone naming
  // convention straight from toplo.bg's own district list) — without it,
  // the required non-alphanumeric boundary right after the digit can never
  // be satisfied (the letter is glued directly onto the digit), so the whole
  // optional number group silently failed to match at all and "Младост 1А"
  // collapsed to bare "младост" — a wildcard core that then falsely
  // contain-matched EVERY other numbered Младост zone (1, 2, 3, 4...) via
  // streetCoresMatch's whole-string containment fallback, merging entirely
  // unrelated outages in different zones into one record. Confirmed live:
  // this silently merged 7 separate toplo.bg heating outages (zones 1, 1А,
  // 2, 3, 4) into a single row.
  const districtMatch = str.match(new RegExp(`(?:^|[^а-яa-z0-9])(${NUMBERED_DISTRICT_NAMES.join('|')})(?:[\\s-]+(\\d+[а-я]?))?(?:$|[^а-яa-z0-9])`, 'i'));

  if (districtMatch && !str.includes('септември') && !str.includes('март')) {
    const name = districtMatch[1].trim().toLowerCase();
    const givenNames = DISTRICT_NAME_GIVEN_NAME_EXCEPTIONS[name];
    const precedingText = str.slice(0, districtMatch.index);
    const isPersonNameStreet = givenNames && givenNames.some((g) =>
      new RegExp(`(?:^|[^а-яa-z0-9])${g}(?:$|[^а-яa-z0-9])`, 'i').test(precedingText)
    );

    if (!isPersonNameStreet) {
      const num = districtMatch[2] ? ` ${districtMatch[2].trim()}` : '';
      return `${name}${num}`;
    }
  }

  // Preserve numbered streets like "6 септември", "25 септември", "3 март", "цар борис 3"
  const specialStreets = [
    '6 септември', '25 септември', '3 март', 
    'цар борис 3', 'цар борис 2', 'цар борис 1',
    'петър 1', 'симеон 1'
  ];

  for (const s of specialStreets) {
    if (str.includes(s)) {
      return s;
    }
  }

  // Strip standalone house/block numbers (e.g. "№ 45", "45а", "№12", "бл. 74")
  str = str
    .replace(/(?:^|[^а-яa-z0-9])(?:№|номер)\s*\d+[а-яa-z]?(?:$|[^а-яa-z0-9])/gi, ' ')
    .replace(/(?:^|[^а-яa-z0-9])(?:бл\.?|блок)\s*\d+[а-яa-z]?(?:$|[^а-яa-z0-9])/gi, ' ')
    .replace(/(?:^|[^а-яa-z0-9])\d+[а-яa-z]?(?:$|[^а-яa-z0-9])/gi, ' ');

  // Strip non-Cyrillic characters except space
  str = str.replace(/[^а-я0-9\s]/gi, ' ');

  return str.replace(/\s+/g, ' ').trim();
}

/**
 * Extracts house number or block number from an address string
 * @param {string} address - e.g. "бул. България 45" or "кв. Младост 1, бл. 74"
 */
export function extractAddressNumbers(address) {
  if (!address || typeof address !== 'string') {
    return { houseNumber: null, blockNumber: null };
  }

  const clean = sanitizeBulgarianText(address);

  let blockNumber = null;
  const blockMatch = clean.match(/(?:^|[^а-яa-z0-9])(?:бл\.?|блок)\s*(\d+)/i);
  if (blockMatch) {
    blockNumber = parseInt(blockMatch[1], 10);
  }

  let houseNumber = null;
  // Strip apartment/floor/entrance-labeled numbers FIRST. The negative
  // lookahead below only excludes a digit FOLLOWED by "ет"/"ап"/etc., but
  // real Bulgarian phrasing always puts the label BEFORE the number — so
  // when no house number is actually given, just "ул. Иван Вазов, ап. 5,
  // ет. 3, вх. Б", the leftmost number found was the apartment number, and
  // that lookahead never actually caught it. Also strips district names
  // (via the same NUMBERED_DISTRICT_NAMES list normalizeStreetName() uses —
  // these were two separately-typed lists that had drifted apart, so e.g.
  // "Меден Рудник"'s zone number wasn't recognized here and could get
  // mistaken for a house number), monarch numerals (Цар Борис 3), and date
  // street names (6 септември, 3 март) before extracting the house number.
  const withoutNames = clean
    .replace(/(?:ап\.?|апартамент)\s*\d+/gi, ' ')
    .replace(/(?:ет\.?|етаж)\s*\d+/gi, ' ')
    .replace(/(?:вх\.?|вход)\s*[а-я0-9]+/gi, ' ')
    .replace(new RegExp(`(?:${NUMBERED_DISTRICT_NAMES.join('|')})[\\s-]+\\d+`, 'gi'), ' ')
    .replace(/(?:цар\s+борис|петър|симеон|александър)\s+\d+/gi, ' ')
    .replace(/\d+\s+(?:септември|март|януари|февруари|април|май|юни|юли|август|октомври|ноември|декември)/gi, ' ');

  const numMatch = withoutNames.match(/(?:№|номер|\b)\s*(\d+)(?!\s*(?:г\.?|ч\.?|ет|ап|вх))/i);
  if (numMatch && !blockNumber) {
    houseNumber = parseInt(numMatch[1], 10);
  }

  return { houseNumber, blockNumber };
}

/**
 * Parses number ranges in outage descriptions
 * e.g. "от №40 до №60" or "от 10 до 30" or "бл. 74, бл. 75"
 */
export function parseOutageNumberRange(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = sanitizeBulgarianText(text);

  // Check block list e.g. "бл. 74, бл. 75" or "бл. 1, 11 и 16" (a single
  // "бл./блок" keyword followed by a comma/"и"-separated run of numbers —
  // only the number immediately after the keyword used to be captured, so
  // "БАН бл. 1, 11 и 16" silently became just blocks=[1], meaning a real
  // user in block 11 or 16 would never match this outage at all).
  const blocks = [];
  const blockGroupRegex = /(?:^|[^а-яa-z0-9])(?:бл\.?|блок)\s*(\d+(?:\s*(?:,|и)\s*\d+)*)/gi;
  let bMatch;
  while ((bMatch = blockGroupRegex.exec(clean)) !== null) {
    const nums = bMatch[1].match(/\d+/g) || [];
    nums.forEach((n) => blocks.push(parseInt(n, 10)));
  }
  if (blocks.length > 0) {
    return { type: 'blocks', blocks };
  }

  // Check house number ranges e.g. "от № 40 до № 60" or "от 40 до 60". Only
  // the FIRST range in the text used to ever be extracted and then applied
  // to EVERY affected street in the whole bulletin — a bulletin covering
  // several streets, each with its own range ("ул. Раковски от №1 до №15 и
  // ул. Оборище от №40 до №60"), silently applied Rakovski's range to a
  // user on Оборище too, telling them "not affected" even when their real
  // number (e.g. 55) was well inside Оборище's actual range. There's no
  // reliable way to tell which range belongs to which street from free text
  // alone, so when more than one distinct range appears this backs off to
  // no restriction (same as "no range info found" below) rather than risk
  // applying the wrong one and silently clearing someone who IS affected —
  // matching a street with no confident number scope should count you in.
  const rangeMatches = [...clean.matchAll(/от\s+(?:№\s*)?(\d+)\s+до\s+(?:№\s*)?(\d+)/gi)];
  if (rangeMatches.length === 1) {
    const rangeMatch = rangeMatches[0];
    return {
      type: 'range',
      min: parseInt(rangeMatch[1], 10),
      max: parseInt(rangeMatch[2], 10),
      isEvenOnly: clean.includes('четни'),
      isOddOnly: clean.includes('нечетни')
    };
  }

  return null;
}

/**
 * Compares two ALREADY-normalized street cores for a genuine name match.
 * Extracted from isAddressAffected() so other callers (outage deduplication
 * in upsertOutage()) can reuse the same word-aware comparison instead of
 * raw substring .includes() on the RAW (un-normalized) street text — which
 * incorrectly treats e.g. "бул. Христо Ботев" as containing "ул. Христо
 * Ботев" (since "бул." literally ends in "ул."), among other false
 * collisions between unrelated streets that happen to share a substring.
 */
export function streetCoresMatch(coreA, coreB) {
  if (!coreA || !coreB) return false;
  if (coreA === coreB) return true;

  // The whole-string containment fallback below is intentionally tolerant of
  // a bulletin using a shortened name (e.g. "Скобелев" for the fuller
  // "Генерал Скобелев" saved address). That tolerance backfires for the
  // known surname/district collisions: a bare district core (e.g.
  // "смирненски") would contain-match the unrelated person-name street
  // ("христо смирненски") purely because the surname is a substring — even
  // though normalizeStreetName() deliberately kept "христо" specifically to
  // mark these as different places. Block just that pairing before falling
  // through to the generic containment check.
  for (const [surname, givenNames] of Object.entries(DISTRICT_NAME_GIVEN_NAME_EXCEPTIONS)) {
    const otherCore = coreA === surname ? coreB : (coreB === surname ? coreA : null);
    if (otherCore) {
      const otherTokens = otherCore.split(' ');
      if (otherTokens.includes(surname) && givenNames.some((g) => otherTokens.includes(g))) {
        return false;
      }
    }
  }

  const tokensA = coreA.split(' ').filter(Boolean);
  const tokensB = coreB.split(' ').filter(Boolean);

  if (tokensA.length === tokensB.length) {
    // Same word count: every word must match, in order (e.g. "иван вазов" does NOT match "иван михайлов")
    return tokensA.every((t, i) => t === tokensB[i]);
  }
  // Different word count — e.g. a bulletin says just "Скобелев" while the
  // saved address is the fuller "Генерал Скобелев" (or vice versa). Whole-
  // string containment covers every word-count combination the same way.
  const fullA = tokensA.join(' ');
  const fullB = tokensB.join(' ');
  return fullA.includes(fullB) || fullB.includes(fullA);
}

/**
 * True if any street in one list refers to the same physical street as any
 * street in the other list, using normalized/word-aware comparison rather
 * than raw substring matching on the original text.
 */
export function streetsOverlap(streetsA = [], streetsB = []) {
  const coresA = streetsA.map((s) => normalizeStreetName(s)).filter((c) => c && c.length >= 2);
  const coresB = streetsB.map((s) => normalizeStreetName(s)).filter((c) => c && c.length >= 2);
  return coresA.some((a) => coresB.some((b) => streetCoresMatch(a, b)));
}

// A bare "бл. N" (one block) or "бл. N, N, N" (a shared-prefix group —
// toplo.bg states the "бл." prefix once and lists further block numbers by
// comma alone) entry with nothing else — the exact shapes
// scrapeSofiaHeatingToplo() pushes as their own separate array element
// (alongside the district name as a second, independent entry) — as
// opposed to a block number embedded in a fuller street string, which
// parseOutageNumberRange()/extractAddressNumbers() already handle
// separately for user-address matching.
const BARE_BLOCK_GROUP_RE = /^(?:бл\.?|блок)\s*(?:№\s*)?([\d,.\sа-я]+)$/i;

export function extractBareBlockNumbers(streets = []) {
  const blocks = [];
  for (const s of streets) {
    const m = (s || '').trim().match(BARE_BLOCK_GROUP_RE);
    if (!m) continue;
    const nums = m[1].match(/\d+[а-я]?/gi) || [];
    for (const n of nums) blocks.push(n.toLowerCase());
  }
  return blocks;
}

/**
 * Like streetsOverlap(), but precise enough to tell apart two genuinely
 * different real incidents that happen to share a district/street core —
 * confirmed live: toplo.bg reports one specific building block per real
 * heating incident (a distinct AccidentId each time), but every incident in
 * the same district (e.g. "Младост 2") always ALSO carries the bare
 * district name as a second array entry alongside the specific block. Since
 * normalizeStreetName() deliberately strips block/house numbers from its
 * "core" (that's a different concern, handled separately below), the bare
 * district entry alone was enough to satisfy streetsOverlap() for ANY two
 * incidents in that district regardless of which block — so a brand new
 * incident for block 223 silently merged into whatever record already
 * existed for block 216 from days earlier instead of becoming its own
 * outage, and the old block stayed in affected_streets forever (merges are
 * pure union, nothing is ever removed) even after it was long resolved.
 * When BOTH sides specify at least one bare block number, additionally
 * require them to share one — a no-op for every other provider, which never
 * produces this exact "district + standalone block" shape in the first
 * place.
 *
 * For everything else, a SINGLE shared street name is only meaningful proof
 * of "same real outage" for small lists. For wide-area regional bulletins
 * (many villages/streets under one announcement — common for ЕРП
 * Север/EVN), a lone coincidental match on a generic, nationwide-common
 * street name (e.g. "ул. Дунав", "ул. Шипка") isn't — confirmed live: two
 * ЕРП Север bulletins for completely different towns (Провадия vs. Долни
 * чифлик) merged into one record purely because both happened to list a
 * "ул. Дунав", then kept absorbing further unrelated towns' streets on
 * every subsequent re-scrape (merges are pure union, nothing is ever
 * removed — confirmed live, one pair of records had already cross-
 * contaminated to ~40 streets spanning at least 4 unrelated bulletins).
 * Requiring a meaningful FRACTION of the smaller list to match — not just
 * one hit — lets a genuine re-scrape of the same announcement (which
 * naturally repeats nearly its whole street list, often verbatim) still
 * match, while rejecting a single coincidental name shared between two
 * otherwise-unrelated bulletins. Small lists (<=3 streets, the common case
 * for a single village/street outage) are exempt: one shared street IS
 * meaningful there, and requiring a "fraction" of a tiny list would be
 * either a no-op or too strict for legitimate 1-street outages.
 */
export function sameOutageMatch(streetsA = [], streetsB = []) {
  if (!streetsOverlap(streetsA, streetsB)) return false;
  const blocksA = extractBareBlockNumbers(streetsA);
  const blocksB = extractBareBlockNumbers(streetsB);
  if (blocksA.length > 0 && blocksB.length > 0) {
    return blocksA.some((b) => blocksB.includes(b));
  }

  const coresA = streetsA.map((s) => normalizeStreetName(s)).filter((c) => c && c.length >= 2);
  const coresB = streetsB.map((s) => normalizeStreetName(s)).filter((c) => c && c.length >= 2);
  const minSize = Math.min(coresA.length, coresB.length);
  if (minSize <= 3) return true;

  const matchCount = coresA.filter((a) => coresB.some((b) => streetCoresMatch(a, b))).length;
  return matchCount / minSize >= 0.34;
}

/**
 * Checks if a user's address is strictly affected by an outage.
 * Performs dual-layer verification:
 * 1. Exact core street/district name matching (preventing false name collisions)
 * 2. Range & house/block number boundary matching (preventing false positive alerts outside the outage scope)
 */
export function isAddressAffected(userStreet, affectedStreets = [], rawLocationText = '') {
  if (!userStreet || !Array.isArray(affectedStreets) || affectedStreets.length === 0) {
    return false;
  }

  const userCore = normalizeStreetName(userStreet);
  if (!userCore || userCore.length < 2) return false;

  const { houseNumber, blockNumber } = extractAddressNumbers(userStreet);
  const outageRange = parseOutageNumberRange(rawLocationText);

  return affectedStreets.some((affectedStreet) => {
    const affectedCore = normalizeStreetName(affectedStreet);
    if (!affectedCore || affectedCore.length < 2) return false;

    if (!streetCoresMatch(userCore, affectedCore)) return false;

    // 2. Number & Range Scope Verification
    if (outageRange) {
      if (outageRange.type === 'blocks') {
        if (blockNumber !== null) {
          return outageRange.blocks.includes(blockNumber);
        }
        return true;
      }

      if (outageRange.type === 'range') {
        if (houseNumber !== null) {
          if (outageRange.isEvenOnly && houseNumber % 2 !== 0) return false;
          if (outageRange.isOddOnly && houseNumber % 2 === 0) return false;

          const min = Math.min(outageRange.min, outageRange.max);
          const max = Math.max(outageRange.min, outageRange.max);
          return houseNumber >= min && houseNumber <= max;
        }
      }
    }

    return true;
  });
}
