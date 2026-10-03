import axios from 'axios';
import * as cheerio from 'cheerio';

async function inspectProviders() {
  const targets = [
    { name: 'ЕРП Север (Енерго-Про)', url: 'https://erpsever.bg/bg/planirani-prekysvaniq' },
    { name: 'EVN България', url: 'https://www.evn.bg/Outages' },
    { name: 'ВиК Пловдив', url: 'https://vik.bg/avarii/' },
    { name: 'ВиК Варна', url: 'https://vikvarna.com/bg/category/avarii.html' },
    { name: 'Софийска вода', url: 'https://www.sofiyskavoda.bg/' }
  ];

  for (const t of targets) {
    try {
      console.log(`\n========================================`);
      console.log(`🔍 Inspecting ${t.name}: ${t.url}`);
      console.log(`========================================`);
      const res = await axios.get(t.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        timeout: 8000
      });
      const $ = cheerio.load(res.data);
      console.log('Title:', $('title').text().trim());

      // Look for tables, cards, lists, boxes
      const boxes = [];
      $('table tr, .card, .item, .box, .news-item, .outage-item, article, li, div[class*="outage"], div[class*="remont"], div[class*="prekysv"]').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text.length > 25 && (text.includes('ремонт') || text.includes('авария') || text.includes('прекъсване') || text.includes('профилактика') || text.includes('спиране') || text.includes('ул.') || text.includes('бул.'))) {
          if (!boxes.some(b => b.includes(text.substring(0, 40)))) {
            boxes.push(text);
          }
        }
      });
      console.log(`Found ${boxes.length} information boxes/cards:`);
      for (const b of boxes.slice(0, 5)) {
        console.log(`  📦 ${b.substring(0, 180)}...`);
      }
    } catch (err) {
      console.log(`Error inspecting ${t.name}:`, err.message);
    }
  }
}

inspectProviders();
