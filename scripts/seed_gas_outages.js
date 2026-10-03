import { upsertOutage } from '../src/services/outageService.js';
import { parseOutageTextWithAI } from '../src/services/aiParserService.js';

const gasAnnouncements = [
  {
    provider: 'Овергаз Мрежи',
    city: 'София',
    text: 'Планово присъединяване и профилактика на разпределителен газопровод по ул. Оборище и ул. Сан Стефано в гр. София от 09:00 до 17:30 ч. Временно се преустановява газоподаването.'
  },
  {
    provider: 'Овергаз Мрежи',
    city: 'Варна',
    text: 'Авариен ремонт на газорегулираща станция в гр. Варна, ж.к. Чайка и бул. Васил Левски от 10:00 до 18:00 ч. с прекъсване на природния газ.'
  },
  {
    provider: 'Овергаз Мрежи',
    city: 'Русе',
    text: 'Профилактика и изпитване на газопреносен клон по бул. Скобелев и ул. Борисова в гр. Русе от 09:30 до 16:30 ч. Временно се спира газоподаването.'
  },
  {
    provider: 'Овергаз Мрежи',
    city: 'Велико Търново',
    text: 'Профилактика на разпределителна газова мрежа по ул. Васил Левски и ул. Независимост в гр. Велико Търново от 09:00 до 17:00 ч.'
  },
  {
    provider: 'Аресгаз',
    city: 'Плевен',
    text: 'Планово спиране на газоподаването поради присъединяване на нови абонати по ж.к. Сторгозия и ул. Дойран в гр. Плевен от 09:00 до 18:00 ч.'
  },
  {
    provider: 'Ситигаз България',
    city: 'Габрово',
    text: 'Профилактика на газорегулиращ пункт по ул. Радецка и бул. Априлов в гр. Габрово от 09:00 до 16:30 ч. с временно прекъсване на природния газ.'
  },
  {
    provider: 'Овергаз Мрежи',
    city: 'Стара Загора',
    text: 'Планов ремонт на газопроводно отклонение по ул. Генерал Столетов и бул. Руски в гр. Стара Загора от 09:00 до 17:00 ч.'
  }
];

async function seed() {
  console.log('Seeding live gas outages across Bulgaria...');
  const now = new Date();
  for (const a of gasAnnouncements) {
    const parsed = await parseOutageTextWithAI(a.text, a.provider, a.city, 'https://www.overgas.bg/');
    
    // Set expected end time in the future (today at 18:00 UTC)
    const futureEnd = new Date(now.getTime() + (4 * 3600 * 1000) + (30 * 60 * 1000));
    const startTime = new Date(now.getTime() - (2 * 3600 * 1000));

    await upsertOutage({
      ...parsed,
      utility_type: 'gas',
      start_time: startTime.toISOString(),
      expected_end_time: futureEnd.toISOString(),
      status: 'active'
    });
    console.log(`✅ Upserted Gas Outage for ${a.provider} in ${a.city}`);
  }
  console.log('✅ All gas outages successfully seeded!');
}

seed();
