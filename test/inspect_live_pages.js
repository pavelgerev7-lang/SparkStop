import axios from 'axios';
import * as cheerio from 'cheerio';

const testUrls = [
  { name: 'Софийска вода', url: 'https://sofiyskavoda.bg/water-stoppages' },
  { name: 'ВиК Йовковци (В. Търново)', url: 'https://www.vik-vt.com' },
  { name: 'ВиК Шумен', url: 'https://www.vik-shumen.net' },
  { name: 'ВиК Варна', url: 'https://vikvarna.com/bg/avarii.html' },
  { name: 'ВиК Пловдив', url: 'https://vik.bg/avarii/' },
  { name: 'ЕРМ Запад (Електрохолд)', url: 'https://ermzapad.bg/bg/za-klienta/prekysvanija/' },
  { name: 'ЕРП Север', url: 'https://erpsever.bg/bg/planirani-prekysvaniq' },
  { name: 'Топлофикация София', url: 'https://toplo.bg/outages' }
];

async function checkUrl(target) {
  try {
    const res = await axios.get(target.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'bg,en;q=0.9'
      },
      timeout: 10000
    });

    const $ = cheerio.load(res.data);
    console.log(`\n========================================`);
    console.log(`✅ [${target.name}] Status: ${res.status} | URL: ${target.url}`);
    
    // Find all links and texts that look like outage announcements
    const items = [];
    $('a, h1, h2, h3, h4, .news-item, .et_pb_post, article, p').each((i, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      const href = $(el).attr('href');
      if (
        (text.length > 20 && text.length < 350) &&
        (
          text.includes('авария') ||
          text.includes('ремонт') ||
          text.includes('спиране') ||
          text.includes('водоподаване') ||
          text.includes('електрозахранване') ||
          text.includes('прекъсване') ||
          text.includes('уведомява') ||
          text.includes('нарушено') ||
          text.includes('без вода') ||
          text.includes('без ток') ||
          text.includes('топлоподаване')
        )
      ) {
        items.push({ text, href });
      }
    });

    console.log(`Found ${items.length} relevant outage text fragments.`);
    items.slice(0, 5).forEach((item, idx) => {
      console.log(`  [${idx + 1}] ${item.text.slice(0, 140)}... (Link: ${item.href || 'none'})`);
    });
  } catch (err) {
    console.log(`\n❌ [${target.name}] FAILED: ${err.message} (${target.url})`);
  }
}

async function main() {
  for (const t of testUrls) {
    await checkUrl(t);
  }
}

main();
