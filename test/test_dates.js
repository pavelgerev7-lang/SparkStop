import { parseBulgarianDateTime, extractStreetsHeuristic } from '../src/services/aiParserService.js';

const samples = [
  {
    name: 'Shumen 1 (22.08.2026 do 21:00)',
    text: 'Днес 22.08.2026 г. поради удължаване на ремонтните дейности на кръстовището на ул. Самара и ул. Генерал Драгомиров, ще бъде спряно водоподаването и към високите части на кв.Б.Българанов, като се очаква да бъде отстранена аварията до 21:00 часа.'
  },
  {
    name: 'Shumen 2 (22.08.2026 ot 12:00 do 19:00)',
    text: 'Днес 22.08.2026 г. поради възникнала авария на ул. Генерал Драгомиров 154 в кв. Боян Българанов ще бъде спряно водоподаването в района на ул. Генерал Драгомиров, ул. Генерал Тотлебен, ул. Дунав, ул. Бели Лом, ул. Искър и част от местност „Под манастира“ от 12:00 часа до 19:00 часа.'
  },
  {
    name: 'Shumen 3 (19.08.2026 ot 9:00 do 15:00)',
    text: 'Поради възникнала авария на ул. Ген. Драгомиров №54 в кв. Боян Българанов, гр.Шумен, ще бъде спряно водоподаването във високите части на квартала на 19.08.2026 год. от 9:00 часа до 15:00 часа.'
  },
  {
    name: 'Active Today (23.08.2026 ot 10:00 do 18:00)',
    text: 'Днес 23.08.2026 г. авария по ул. Цар Освободител от 10:00 до 18:00 ч.'
  }
];

console.log(`Current Time: ${new Date().toISOString()}`);
for (const s of samples) {
  const dt = parseBulgarianDateTime(s.text);
  const streets = extractStreetsHeuristic(s.text);
  console.log(`\n[${s.name}]`);
  console.log(`  Streets:`, streets);
  console.log(`  Start: ${dt.start_time}`);
  console.log(`  End: ${dt.expected_end_time}`);
  console.log(`  Status: ${dt.status}`);
}
