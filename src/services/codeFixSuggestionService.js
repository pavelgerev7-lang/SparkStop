import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let genAI = null;
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

// The two files that have accounted for every real content-classification
// bug found via the source-content audit so far: the fake-announcement
// filter and the heuristic street/date extractor. Read fresh on every call
// (not cached) since they're exactly the files a human might be actively
// editing between audit runs.
const RELEVANT_FILES = [
  { rel: '../utils/textCleaner.js', display: 'src/utils/textCleaner.js' },
  { rel: './aiParserService.js', display: 'src/services/aiParserService.js' },
  { rel: '../../test/test_backend.js', display: 'test/test_backend.js' }
];

// Distilled from the actual fixes made this session so the model doesn't
// have to rediscover the same lessons from scratch on every call — without
// this it tends to propose the exact class of fix already tried and
// rejected earlier (e.g. a plain .includes() check, or a blunt
// "date far in the past/future = suspicious" rule).
const SUGGESTION_SYSTEM_INSTRUCTION = `
Ти си старши JavaScript разработчик, който помага да се отстрани конкретен бъг в българско приложение за проследяване на комунални аварии (SparkDrop). Работиш върху код, писан от друг AI (Claude) — прочети внимателно съществуващия стил и разсъждения (в коментарите) и го следвай, вместо да въвеждаш собствен стил.

Ще ти бъде даден: (1) пълното съдържание на релевантните файлове, включително тестовия файл, (2) описание на конкретен проблем от автоматична проверка на живо срещу реален източник, (3) примерен текст, който демонстрира проблема.

УСТАНОВЕНИ ПРИНЦИПИ В ТОЗИ КОДБАЗ (следвай ги стриктно):
1. JavaScript-овото word boundary (\\b) НЕ разпознава кирилица. Никога не разчитай на \\b с кирилски букви — вместо това провери съседния символ явно, напр. (?:^|[^а-яa-z]) преди маркер.
2. Проста .includes()/substring проверка е опасна — провери дали думата може да съвпадне СРЕД друга дума (напр. "ул " съвпада вътре в "радиомодул "; "с. " съвпада в края на "бизнес. "). Винаги провери реално с примери, преди да предложиш проверка.
3. Правилата за "фалшива обява" (isAnnouncementIndicatingNoOutage) понякога трябва да се проверяват БЕЗ !hasStreet guard-а, когато боилърплейт текстът може легитимно да съдържа истински адрес (напр. собствения адрес на офиса на компанията, или улица спомената в историята на компанията).
4. Не предлагай грубо правило от рода "дата твърде далеч в бъдещето/миналото = съмнително" — легитимни планови ремонти (напр. ЕРП Север/EVN) се обявяват дни/седмици предварително, а някои сайтове легитимно държат стари обяви с реални минали дати с години. Единственият надежден сигнал е когато статусът НЕ отговаря коректно на датите (напр. status='active' въпреки че expected_end_time е в миналото).
5. Поправяй СПОДЕЛЕНАТА функция (isAnnouncementIndicatingNoOutage / extractStreetsHeuristic), не добавяй специален случай на друго място — тази функция се ползва И при скрейпване, И на всеки 20 минути от самопочистващата проверка (runDataIntegritySweep), така че една поправка тук ретроактивно оправя и вече съществуващи записи.
6. Генерализирай, когато е възможно (регулярен израз/шаблон, а не буквалното конкретно име на компанията), тъй като целта е бъдещи, все още невидени доставчици със същия тип текст да минат правилно без нова ръчна поправка.

Твоята задача: предложи МИНИМАЛНА, конкретна промяна в кода, която решава ТОЧНО дадения проблем, без да пренаписваш цели файлове и без да въвеждаш нови абстракции.

Формат на отговора (стриктно тези секции, на български):
1. **Причина**: 1-2 изречения защо точно се случва бъгът (кой ред/проверка се задейства грешно).
2. **Поправка**: код "преди" и код "след" (или ясен diff), показващи точно какво да се промени — само засегнатите редове, не целия файл.
3. **Проверка срещу регресия**: изрично посочи кои съществуващи тестове от дадения test_backend.js (или познати случаи като "жк Изгрев" без точки, "с. Крушаре", "ул. Раковски") НЯМА да бъдат засегнати от промяната, и защо.

Ако след прочитане на кода прецениш, че текстът всъщност НЕ е бъг (вече се обработва правилно, напр. статусът вече коректно излиза "resolved"), кажи го директно вместо да предлагаш излишна промяна.
`;

/**
 * Given one flagged entry from the source-content audit (provider, city,
 * url, issues[], sample text), asks Gemini to read the actual current code
 * of the two files responsible for this class of bug and suggest a minimal
 * fix — returned as plain text for a human to review and apply by hand.
 * Never writes to disk itself.
 */
export async function suggestCodeFixForIssue(entry) {
  if (!genAI || !process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY не е конфигуриран на сървъра — не може да се генерира предложение.');
  }
  if (!entry) {
    throw new Error('Липсва информация за проблема.');
  }

  const fileContents = RELEVANT_FILES.map(({ rel, display }) => {
    const abs = path.resolve(__dirname, rel);
    const content = fs.readFileSync(abs, 'utf-8');
    return `--- ${display} ---\n${content}`;
  }).join('\n\n');

  const issuesText = (entry.issues || [])
    .map((iss) => `- ${iss.problem}${iss.sample ? `\n  Пример от реалния текст: "${iss.sample}..."` : ''}`)
    .join('\n');

  const prompt = `Открит проблем при доставчик "${entry.provider}" (${entry.city}), източник: ${entry.url}\n\nОписание на проблема от автоматичната проверка:\n${issuesText || 'Няма конкретно описание — виж примерния текст.'}\n${entry.sample ? `\nПримерен изтеглен текст: "${entry.sample}..."` : ''}\n\nПълен код на релевантните файлове:\n\n${fileContents}`;

  // Tried 'gemini-pro-latest' here first, on the theory that a single manual
  // click can afford a slower, more capable "pro"-tier model for genuinely
  // better code reasoning. Confirmed live it's a dead end on a free API key
  // specifically — not just usage-based like the flash models below, but a
  // structural "limit: 0" on this project's plan (pro tier requires billing
  // enabled on the Google account, no free quota exists for it at all), so
  // it's not worth even trying — every attempt is a guaranteed wasted round
  // trip. Left as flash-only until/unless billing is ever added.
  // The flash models share the SAME per-model daily free-tier quota (20
  // requests/day) that the scraper's own AI parsing burns through —
  // confirmed live, a single click hit an already-exhausted
  // "gemini-flash-latest" — so trying all three in sequence meaningfully
  // improves the odds one still has quota left today.
  const candidateModels = ['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-3.5-flash'];
  let lastErr = null;

  for (const modelName of candidateModels) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: SUGGESTION_SYSTEM_INSTRUCTION,
        // Low temperature: a code-fix suggestion should be precise and
        // reproducible, not creative — this isn't prose generation.
        generationConfig: { temperature: 0.15 }
      });
      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('AI заявката отне твърде дълго (>45s).')), 45000))
      ]);
      const text = result.response?.text()?.trim();
      return text || 'AI-то не върна отговор.';
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️ [SUGGEST FIX] ${modelName} failed, trying next candidate:`, err.message);
    }
  }

  const isQuotaError = /429|quota/i.test(lastErr?.message || '');
  if (isQuotaError) {
    throw new Error('Дневната безплатна AI квота на всички модели е изчерпана (споделя се със скрейпъра). Опитай пак по-късно днес или утре.');
  }
  throw new Error(lastErr?.message || 'AI заявката се провали по неизвестна причина.');
}
