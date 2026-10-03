import { parseOutageTextWithAI } from '../src/services/aiParserService.js';

async function testShumenAI() {
  const article1 = `Съобщение (22 авг. 2026): Днес 22.08.2026 г. поради удължаване на ремонтните дейности на кръстовището на ул. Самара и ул. Генерал Драгомиров, ще бъде спряно водоподаването и към високите части на кв.Б.Българанов, като се очаква да бъде отстранена аварията до 21:00 часа.`;
  const url1 = 'https://www.vik-shumen.net/saobshtenie-1138/';

  const article2 = `Съобщение (22 авг. 2026): Днес 22.08.2026 г. поради възникнала авария на ул. Генерал Драгомиров 154 в кв. Боян Българанов ще бъде спряно водоподаването в района на ул. Генерал Драгомиров, ул. Генерал Тотлебен, ул. Дунав, ул. Бели Лом, ул. Искър и част от местност „Под манастира“ от 12:00 часа до 19:00 часа.`;
  const url2 = 'https://www.vik-shumen.net/saobshtenie-1137/';

  console.log('Testing Article 1...');
  const res1 = await parseOutageTextWithAI(article1, 'ВиК Шумен', 'Шумен', url1);
  console.log('Result 1:', JSON.stringify(res1, null, 2));

  console.log('\nTesting Article 2...');
  const res2 = await parseOutageTextWithAI(article2, 'ВиК Шумен', 'Шумен', url2);
  console.log('Result 2:', JSON.stringify(res2, null, 2));
}

testShumenAI().catch(console.error);
