import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { query } from '../config/db.js';
import { getScraperHealthSummary } from './scraperHealthService.js';
import { isModelQuotaExhausted, markModelQuotaExhausted, isModelInTransientCooldown, recordModelOutcome } from './aiParserService.js';

dotenv.config();

let genAI = null;
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

// The ONLY actions this whole feature can ever perform — the AI below never
// executes code or SQL of its own; it only ever picks one of these six
// literal strings plus a few scalar params (city/provider/utility_type/
// older_than_hours). executeAdminChatAction() is the single place any of
// them actually touch the database, and every query there is parameterized
// (or, for older_than_hours, coerced through Math.round/clamp into a
// guaranteed-safe integer before ever reaching a SQL string) — the AI's own
// JSON output is treated purely as data selecting from this fixed menu,
// never as instructions to run, the same trust boundary already applied to
// AI-parsed scraped text elsewhere in this codebase. "chat" is the one
// exception that never touches the database at all — it's pure
// conversation, so its own freedom to say anything carries zero execution
// risk by construction, regardless of how open-ended the reply is.
const ALLOWED_ACTIONS = ['search_outages', 'scraper_health', 'stats_summary', 'delete_stale_outages', 'chat'];

const SYSTEM_INSTRUCTION = `
Ти си AI асистентът на СпаркСтоп — платформа за проследяване на комунални аварии (ток, вода, топлофикация, газ) в реално време в България. Говориш с истинския, оторизиран собственик/администратор на системата, не с обикновен потребител. Можеш свободно да разговаряш с него, да обясняваш как работи системата, да отговаряш на общи въпроси за българските комунални доставчици, да даваш мнение и съвети — не си ограничен само до кратки команди.

Задачата ти е да превърнеш всяко негово съобщение в JSON обект, като избереш ТОЧНО ЕДНА от следните "action" стойности:

- "search_outages": преглед на текущи (активни/планирани) аварии от базата данни. Параметри по избор: city, provider, utility_type ("water"/"electricity"/"heating"/"gas").
- "scraper_health": преглед на здравето/аномалиите на скрейпърите от базата данни.
- "stats_summary": обща статистика за платформата по тип комунална услуга и статус от базата данни.
- "delete_stale_outages": ИЗТРИВАНЕ на стари, вече приключени (resolved) аварии от базата данни. Параметри: city (по избор), provider (по избор), older_than_hours (число часове). ВАЖНО: ако администраторът изрично спомене брой часове/дни/седмици (напр. "по-стари от 200 часа", "над 5 дни", "над 2 седмици"), ЗАДЪЛЖИТЕЛНО извлечи и преобразувай ТОЧНО тази стойност в часове (5 дни = 120, 2 седмици = 336). Използвай 72 САМО ако не е споменат период.
- "chat": ВСИЧКО останало — общ разговор, въпрос, обяснение, мнение, поздрав, каквото и да е, което не иска директно данни от базата. За това действие "reply" НЕ е кратко резюме — това Е целият ти отговор към администратора, затова говори свободно, пълно и полезно, colкото дълго е нужно, все едно чатиш директно с него. Можеш да обясняваш функции на СпаркСтоп (одит, здраве на скрейпъри, автопочистване, геокодиране и т.н.), да отговаряш на общи въпроси, да коментираш, да предлагаш идеи.

Пример 1: "Изтрий остарелите аварии по-стари от 200 часа" -> {"action":"delete_stale_outages","params":{"older_than_hours":200},"reply":"Ще прегледам аварии, приключени преди повече от 200 часа."}
Пример 2: "как работи одитът?" -> {"action":"chat","params":{},"reply":"Одитът (Dry Run) сканира сайтовете на всички доставчици в реално време и сравнява намереното с това, което вече имаме в базата данни. Показва ти само РЕАЛНО липсващи и все още актуални аварии за преглед — ти решаваш кои да одобриш, преди да се качат на публичната карта. Нищо не се записва автоматично."}

Отговори САМО с валиден JSON, без markdown блокове, точно в този формат:
{"action": "...", "params": {...}, "reply": "твоят отговор на български — кратък за действията с данни, но пълен и свободен за 'chat'"}

ТИ самият никога не изпълняваш код или SQL — само избираш действие от списъка по-горе; самото четене/писане в базата (и всички защити, напр. потвърждение преди изтриване) е изцяло отговорност на бекенда. "chat" е единственото действие без никакъв достъп до базата — там свободата ти в текста е пълна, защото не носи никакъв риск за изпълнение.
`;

function heuristicClassify(message) {
  const lower = (message || '').toLowerCase();
  const cityHint = lower.match(/(софия|пловдив|варна|бургас|русе|плевен|перник|стара загора|велико търново)/i);
  const utilityHint = lower.includes('ток') || lower.includes('електро') ? 'electricity'
    : lower.includes('вода') ? 'water'
    : lower.includes('парно') || lower.includes('топло') ? 'heating'
    : lower.includes('газ') ? 'gas' : undefined;

  if (/изтри|премахни|изчисти остарел/i.test(lower)) {
    let olderThanHours;
    const hoursMatch = lower.match(/(\d+)\s*час/);
    const daysMatch = lower.match(/(\d+)\s*(?:дни|ден)/);
    const weeksMatch = lower.match(/(\d+)\s*седмиц/);
    if (hoursMatch) olderThanHours = parseInt(hoursMatch[1], 10);
    else if (daysMatch) olderThanHours = parseInt(daysMatch[1], 10) * 24;
    else if (weeksMatch) olderThanHours = parseInt(weeksMatch[1], 10) * 24 * 7;
    return { action: 'delete_stale_outages', params: { city: cityHint ? cityHint[1] : undefined, older_than_hours: olderThanHours }, reply: 'Ще прегледам остарелите аварии преди изтриване.' };
  }
  // (?!ей) — found live: a plain "Здравей!" greeting was matching the bare
  // "здрав" substring (shares its first 5 letters with "здраве"/health) and
  // misfiring as a scraper-health lookup instead of falling through to chat.
  if (/здрав(?!ей)|скрейпър|счупен|аномал/i.test(lower)) {
    return { action: 'scraper_health', params: {}, reply: 'Проверявам здравето на скрейпърите.' };
  }
  if (/статистика|общо колко|обобщение/i.test(lower)) {
    return { action: 'stats_summary', params: {}, reply: 'Показвам обща статистика.' };
  }
  if (cityHint || utilityHint || /авари|провери|покажи/i.test(lower)) {
    return { action: 'search_outages', params: { city: cityHint ? cityHint[1] : undefined, utility_type: utilityHint }, reply: 'Търся текущи аварии по зададените критерии.' };
  }
  return { action: 'chat', params: {}, reply: 'В момента AI разговорът е временно недостъпен (Gemini не отговаря), но мога директно да: търся аварии, проверявам здравето на скрейпърите, покажа обща статистика или изтрия остарели аварии — просто кажи кое от тях.' };
}

// history: recent turns from THIS chat session, [{role:'user'|'ai', text}],
// so multi-turn conversation ("а какво ще стане ако..." referring to the
// previous reply) actually has context instead of every message being
// classified in isolation. Frontend caps this to the last ~10 turns.
// Same 3-model candidate fallback as aiParserService.js's own AI call, and
// deliberately sharing ITS quota/cooldown state (imported, not a separate
// copy) — found live: this used to hardcode a single model
// ('gemini-flash-latest') with no fallback at all, so once that model's
// daily quota was exhausted by the scraper's own heavy usage, EVERY chat
// message silently fell straight to the crude keyword heuristic — e.g. a
// plain "Здравей! Как работи одитът?" greeting matched the heuristic's
// "здрав" substring check and misfired as a scraper-health lookup instead
// of an actual conversational answer. Trying the other 2 candidates first
// (both usually still have quota left since scraping exhausts them at a
// different rate) keeps real AI answers working far more of the time.
const CANDIDATE_MODELS = ['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-3.5-flash'];

export async function classifyAdminChatMessage(message, history = []) {
  if (!genAI || !process.env.GEMINI_API_KEY) {
    return heuristicClassify(message);
  }

  const historyText = Array.isArray(history) && history.length > 0
    ? `Предишен разговор с този администратор (за контекст, не за преизпълнение):\n${history.map((h) => `${h.role === 'user' ? 'Администратор' : 'Ти'}: ${h.text}`).join('\n')}\n\n`
    : '';
  const prompt = `${historyText}Ново съобщение на администратора:\n<ADMIN_MESSAGE>\n${message}\n</ADMIN_MESSAGE>`;

  for (const modelName of CANDIDATE_MODELS) {
    if (isModelQuotaExhausted(modelName) || isModelInTransientCooldown(modelName)) continue;
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: SYSTEM_INSTRUCTION,
        generationConfig: { responseMimeType: 'application/json' }
      });
      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini request timed out after 15s')), 15000))
      ]);
      const responseText = result.response?.text()?.trim();
      if (!responseText) throw new Error('empty response');
      const cleaned = responseText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      if (!parsed || !ALLOWED_ACTIONS.includes(parsed.action)) throw new Error('action not in allow-list');
      recordModelOutcome(modelName, true);
      return { action: parsed.action, params: parsed.params && typeof parsed.params === 'object' ? parsed.params : {}, reply: typeof parsed.reply === 'string' ? parsed.reply : '' };
    } catch (err) {
      console.warn(`⚠️ [AI CHAT] ${modelName} failed, trying next candidate:`, err.message);
      const isQuotaError = /429|quota/i.test(err.message || '');
      if (isQuotaError) markModelQuotaExhausted(modelName);
      else recordModelOutcome(modelName, false);
    }
  }

  console.warn('⚠️ [AI CHAT] all candidate models failed — falling back to heuristic classifier.');
  return heuristicClassify(message);
}

/**
 * The one place any admin-chat action actually touches the database. Every
 * filter is bound as a parameterized query argument; older_than_hours is
 * clamped to a guaranteed-safe integer (never raw AI/user text) before it's
 * the one value interpolated into a SQL string, for the INTERVAL literal
 * Postgres requires there. delete_stale_outages ALWAYS returns a preview
 * (never deletes) unless confirmed === true, which only ever happens when
 * the admin clicks the chat's own "Потвърди" button echoing back the exact
 * pending_action this function itself returned — never from re-classifying
 * a later free-text message.
 */
export async function executeAdminChatAction(action, params = {}, confirmed = false) {
  const city = typeof params.city === 'string' && params.city.trim() ? params.city.trim() : null;
  const provider = typeof params.provider === 'string' && params.provider.trim() ? params.provider.trim() : null;
  const utilityType = ['water', 'electricity', 'heating', 'gas'].includes(params.utility_type) ? params.utility_type : null;

  if (action === 'search_outages') {
    const conditions = [`status IN ('active', 'scheduled')`];
    const args = [];
    if (city) { args.push(city); conditions.push(`LOWER(city) = LOWER($${args.length})`); }
    if (provider) { args.push(`%${provider}%`); conditions.push(`provider ILIKE $${args.length}`); }
    if (utilityType) { args.push(utilityType); conditions.push(`utility_type = $${args.length}`); }
    const sql = `SELECT provider, city, utility_type, raw_location_text, start_time, expected_end_time, status FROM outages WHERE ${conditions.join(' AND ')} ORDER BY start_time DESC LIMIT 15`;
    const res = await query(sql, args);
    if (!res) return { type: 'result', summary: 'Базата данни не е достъпна в момента (локален режим без PostgreSQL).', rows: [] };
    const rows = res.rows || [];
    return {
      type: 'result',
      summary: `Намерени ${rows.length} текущи аварии${city ? ` в ${city}` : ''}${utilityType ? ` (${utilityType})` : ''}${provider ? ` от ${provider}` : ''}.`,
      rows
    };
  }

  if (action === 'scraper_health') {
    const summary = await getScraperHealthSummary();
    return {
      type: 'result',
      summary: summary.regression_count > 0
        ? `⚠️ ${summary.regression_count} доставчик(а) показват аномалия точно сега.`
        : '✅ Всички скрейпъри изглеждат здрави — няма засечени аномалии в последните 48ч.',
      rows: summary.regressions
    };
  }

  if (action === 'stats_summary') {
    const res = await query(`SELECT utility_type, status, COUNT(*)::int AS count FROM outages GROUP BY utility_type, status ORDER BY utility_type, status`, []);
    if (!res) return { type: 'result', summary: 'Базата данни не е достъпна в момента (локален режим без PostgreSQL).', rows: [] };
    return { type: 'result', summary: 'Обща статистика по тип услуга и статус.', rows: res.rows || [] };
  }

  if (action === 'delete_stale_outages') {
    let hours = 72;
    if (typeof params.older_than_hours === 'number' && Number.isFinite(params.older_than_hours)) {
      hours = Math.max(1, Math.min(8760, Math.round(params.older_than_hours)));
    }
    const conditions = [`status = 'resolved'`, `expected_end_time < NOW() - INTERVAL '${hours} hours'`];
    const args = [];
    if (city) { args.push(city); conditions.push(`LOWER(city) = LOWER($${args.length})`); }
    if (provider) { args.push(`%${provider}%`); conditions.push(`provider ILIKE $${args.length}`); }
    const whereSql = conditions.join(' AND ');

    if (!confirmed) {
      const countRes = await query(`SELECT COUNT(*)::int AS n FROM outages WHERE ${whereSql}`, args);
      if (!countRes) return { type: 'result', summary: 'Базата данни не е достъпна в момента (локален режим без PostgreSQL).', rows: [] };
      const total = countRes.rows?.[0]?.n || 0;
      const previewRes = total > 0
        ? await query(`SELECT id, provider, city, utility_type, raw_location_text, expected_end_time FROM outages WHERE ${whereSql} ORDER BY expected_end_time ASC LIMIT 10`, args)
        : null;
      return {
        type: total > 0 ? 'confirm_required' : 'result',
        summary: total > 0
          ? `Ще изтрия ${total} остарели, вече приключени аварии (по-стари от ${hours}ч.)${city ? ` в ${city}` : ''}${provider ? ` от ${provider}` : ''}. Потвърди за да продължа.`
          : 'Няма намерени остарели аварии за изтриване по тези критерии.',
        rows: previewRes?.rows || [],
        pending_action: total > 0 ? { action: 'delete_stale_outages', params: { city, provider, older_than_hours: hours } } : null
      };
    }

    const deleteRes = await query(`DELETE FROM outages WHERE ${whereSql} RETURNING id`, args);
    if (!deleteRes) return { type: 'result', summary: 'Базата данни не е достъпна в момента (локален режим без PostgreSQL).', rows: [] };
    const deletedCount = deleteRes.rows?.length || 0;
    return { type: 'result', summary: `🗑️ Изтрити ${deletedCount} остарели аварии.`, rows: [] };
  }

  return { type: 'result', summary: 'Не разпознах това действие.', rows: [] };
}
