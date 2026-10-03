import axios from 'axios';
import * as cheerio from 'cheerio';

const targets = [
  { provider: 'ВиК Йовковци', city: 'Велико Търново', url: 'https://www.vik-vt.com' },
  { provider: 'ВиК Шумен', city: 'Шумен', url: 'https://www.vik-shumen.net' },
  { provider: 'ВиК Пловдив', city: 'Пловдив', url: 'https://vik.bg/avarii/' },
  { provider: 'ВиК Варна', city: 'Варна', url: 'https://vikvarna.com' },
  { provider: 'Софийска вода', city: 'София', url: 'https://www.sofiyskavoda.bg' },
  { provider: 'ЕРМ Запад (Електрохолд)', city: 'София', url: 'https://www.ermzapad.bg' },
  { provider: 'ЕРП Север', city: 'Варна', url: 'https://erpsever.bg/bg/planirani-prekysvaniq' },
  { provider: 'EVN България', city: 'Пловдив', url: 'https://www.evn.bg/Outages' },
  { provider: 'ВиК Бургас', city: 'Бургас', url: 'https://vik-burgas.com' },
  { provider: 'ВиК Русе', city: 'Русе', url: 'https://vik-ruse.com' },
  { provider: 'ВиК Стара Загора', city: 'Стара Загора', url: 'https://www.wik-stz.com' }
];

async function verify() {
  for (const t of targets) {
    try {
      const res = await axios.get(t.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 6000
      });
      const $ = cheerio.load(res.data);
      let foundArticles = [];
      $('a, .news-item, .post, article, p, h1, h2, h3').each((i, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        const href = $(el).attr('href');
        if (
          text.length > 25 &&
          (
            text.includes('авар') ||
            text.includes('ремонт') ||
            text.includes('спиран') ||
            text.includes('водоподав') ||
            text.includes('прекъсван') ||
            text.includes('уведом') ||
            text.includes('ток') ||
            text.includes('вода')
          )
        ) {
          foundArticles.push({ text: text.slice(0, 100), href });
        }
      });
      console.log(`✅ [${res.status}] ${t.provider} (${t.city}): Found ${foundArticles.length} outage items.`);
      if (foundArticles.length > 0) {
        console.log(`   Sample: "${foundArticles[0].text}" (Link: ${foundArticles[0].href || 'none'})`);
      }
    } catch (e) {
      console.log(`❌ [FAIL] ${t.provider} (${t.city}): ${e.message}`);
    }
  }
}

verify();
