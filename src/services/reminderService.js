import { query, inMemoryDB } from '../config/db.js';
import { sendOutageReminder } from './notificationService.js';
import { hasExplicitTimeInText, getDailyScheduleInfo } from './aiParserService.js';

// Reminders about an outage that was announced in advance, sent to the devices whose saved address it affects:
//   day_before  ~24 h before it starts        "📅 Утре: спиране на тока"
//   hour_before ~1 h before it starts         "⏰ След 1 час: спиране на тока"
//   ended       when its announced end passes "✅ Ремонтът приключи"
// (The message when an outage is first announced is sent by notificationService.notifyAffectedUsersForOutage.)
//
// A reminder is only sent when it says something true: the announcement must state a real clock time (an
// estimated 08:00–17:00 is not one), a 24 h reminder needs the outage to have been announced more than a day
// ahead (otherwise it repeats the announcement), and a late reminder is dropped rather than sent stale.
// Nothing is pushed at night (23:00–06:00 Sofia): a day-before reminder due then waits for 06:00, a
// one-hour reminder or an "ended" that falls in the night is dropped.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const TIME_ZONE = 'Europe/Sofia';

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
function sofiaParts(date) {
  const p = {};
  for (const { type, value } of partsFormatter.formatToParts(date)) p[type] = value;
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute) };
}
const dayNumber = (p) => Date.UTC(p.year, p.month - 1, p.day) / 86400000;
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (p) => `${pad2(p.hour)}:${pad2(p.minute)}`;
const ddmm = (p) => `${pad2(p.day)}.${pad2(p.month)}`;
const toMs = (value) => (value ? new Date(value).getTime() : NaN);

/** No reminder is pushed between 23:00 and 06:00 Sofia time. */
export function isReminderNight(now = new Date()) {
  const hour = sofiaParts(now).hour;
  return hour >= 23 || hour < 6;
}

/**
 * Which reminders are due for `outage` right now.
 * @returns {('day_before'|'hour_before'|'ended')[]}
 */
export function dueReminderKinds(outage, now = new Date()) {
  const start = toMs(outage.start_time);
  const end = toMs(outage.expected_end_time);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  if (!hasExplicitTimeInText(outage.raw_location_text)) return [];

  const created = toMs(outage.created_at);
  const announcedAhead = Number.isFinite(created) ? start - created : Infinity;
  const t = now.getTime();

  const kinds = [];
  if (announcedAhead >= 25 * HOUR && t >= start - 24 * HOUR && t <= start - 3 * HOUR) kinds.push('day_before');
  if (announcedAhead >= 2 * HOUR && t >= start - HOUR && t <= start - 5 * MINUTE) kinds.push('hour_before');
  // Only for an outage we knew about while it was running, and only shortly after its announced end.
  if (t >= end && t <= end + 3 * HOUR && (!Number.isFinite(created) || created < end)) kinds.push('ended');
  return kinds;
}

const UTILITY_TEXT = {
  electricity: { stop: 'спиране на тока', back: 'токът трябва да е възстановен', tip: 'Заредете телефона и другите устройства.' },
  water: { stop: 'спиране на водата', back: 'водата трябва да е върната', tip: 'Съберете малко вода предварително.' },
  heating: { stop: 'спиране на парното', back: 'парното трябва да е възстановено', tip: '' },
  gas: { stop: 'спиране на газта', back: 'газоподаването трябва да е възстановено', tip: '' }
};

// "Вкъщи · ул. Иван Вазов 5" — but not "ул. Иван Вазов 5 · ул. Иван Вазов 5" when the label is just the address.
function placeText(label, street) {
  const l = String(label || '').trim();
  const s = String(street || '').trim();
  if (!l) return s;
  if (!s) return l;
  const norm = (x) => x.toLowerCase().replace(/\s+/g, ' ');
  if (norm(s).includes(norm(l))) return s;
  if (norm(l).includes(norm(s))) return l;
  return `${l} · ${s}`;
}

// "от 09:00 до 17:00 ч.", "всеки ден 08:00–12:00 и 14:00–17:00 ч." or, across days, "от 28.09 09:00 до 30.09 17:00 ч.".
function whenText(outage) {
  const daily = getDailyScheduleInfo(outage.raw_location_text, outage.start_time, outage.expected_end_time);
  if (daily) return `${daily.multi_day ? 'всеки ден ' : ''}${daily.windows_text} ч.`;
  const s = sofiaParts(new Date(outage.start_time));
  const e = sofiaParts(new Date(outage.expected_end_time));
  if (dayNumber(s) === dayNumber(e)) return `от ${hhmm(s)} до ${hhmm(e)} ч.`;
  return `от ${ddmm(s)} ${hhmm(s)} до ${ddmm(e)} ${hhmm(e)} ч.`;
}

/** The push text (title shown big, body under it) for one reminder about one saved address. */
export function buildReminderMessage(kind, { outage, label, street, now = new Date() }) {
  const u = UTILITY_TEXT[outage.utility_type] || UTILITY_TEXT.water;
  const place = placeText(label, street);
  const start = new Date(outage.start_time);

  if (kind === 'day_before') {
    const daysAhead = dayNumber(sofiaParts(start)) - dayNumber(sofiaParts(now));
    const dayWord = daysAhead <= 0 ? 'Днес' : daysAhead === 1 ? 'Утре' : ddmm(sofiaParts(start));
    return { title: `📅 ${dayWord}: ${u.stop}`, body: `${place} — ${whenText(outage)}${u.tip ? ` ${u.tip}` : ''}` };
  }
  if (kind === 'hour_before') {
    const minutes = Math.max(1, Math.round((start.getTime() - now.getTime()) / MINUTE));
    const left = minutes >= 50 ? 'След 1 час' : `След ${minutes} мин.`;
    return { title: `⏰ ${left}: ${u.stop}`, body: `${place} — ${whenText(outage)}${u.tip ? ` ${u.tip}` : ''}` };
  }
  return {
    title: '✅ Ремонтът приключи',
    body: `${place} — според графика ${u.back}. Ако още има проблем, проверете в СпаркСтоп.`
  };
}

// Outages that can have a reminder due in the next few minutes: starting within the next day, or ended in the last 3 hours.
async function loadCandidateOutages(now) {
  const t = now.getTime();
  const res = await query(
    `SELECT id, utility_type, provider, city, region, raw_location_text, affected_streets, start_time, expected_end_time, status, created_at
     FROM outages
     WHERE status IN ('active', 'scheduled')
       AND ((start_time > $1 AND start_time <= $2)
         OR (expected_end_time <= $1 AND expected_end_time > $3 AND start_time < expected_end_time))`,
    [now.toISOString(), new Date(t + 25 * HOUR).toISOString(), new Date(t - 3 * HOUR).toISOString()]
  );
  if (res && res.rows) return res.rows;
  return inMemoryDB.outages.filter((o) => {
    if (!['active', 'scheduled'].includes(o.status)) return false;
    const start = toMs(o.start_time);
    const end = toMs(o.expected_end_time);
    return (start > t && start <= t + 25 * HOUR) || (end <= t && end > t - 3 * HOUR && start < end);
  });
}

/** One pass of the reminder job (called every 5 minutes). */
export async function runReminderJob(now = new Date()) {
  if (isReminderNight(now)) return { skipped: 'night', checked: 0, sent: 0 };

  const outages = await loadCandidateOutages(now);
  let sent = 0;
  for (const outage of outages) {
    if (!outage.city || !Array.isArray(outage.affected_streets)) continue;
    for (const kind of dueReminderKinds(outage, now)) {
      try {
        const result = await sendOutageReminder(outage, kind, (item) => buildReminderMessage(kind, { outage, label: item.label, street: item.street, now }));
        sent += result.sent;
      } catch (err) {
        console.error(`❌ [REMINDERS] ${kind} for outage ${outage.id} failed:`, err.message);
      }
    }
  }
  if (sent > 0) console.log(`🔔 [REMINDERS] Sent ${sent} reminder(s).`);
  return { checked: outages.length, sent };
}
