import axios from 'axios';
import * as cheerio from 'cheerio';

async function inspectPowerPortals() {
  const targets = [
    { name: 'EVN', url: 'https://www.evn.bg/Outages' },
    { name: 'ERP Sever', url: 'https://erpsever.bg/bg/planirani-prekysvaniq' },
    { name: 'ERM Zapad', url: 'https://ermzapad.bg/bg/prekusvaniya/' }
  ];

  for (const t of targets) {
    try {
      const res = await axios.get(t.url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 7000
      });
      console.log(`\n=== ${t.name}: ${t.url} (Status: ${res.status}, Length: ${res.data.length}) ===`);
      const $ = cheerio.load(res.data);
      console.log('Title:', $('title').text().trim());

      // Look for region filters, tables, links
      $('a').slice(0, 15).each((_, el) => {
        const href = $(el).attr('href') || '';
        const txt = $(el).text().replace(/\s+/g, ' ').trim();
        if (href.includes('tarnovo') || href.includes('plovdiv') || href.includes('prekusv') || href.includes('avarii') || txt.includes('Търново') || txt.includes('Пловдив') || txt.includes('Прекъсван')) {
          console.log(`[${t.name} link] ${txt} -> ${href}`);
        }
      });
    } catch (e) {
      console.log(`Error on ${t.name}: ${e.message}`);
    }
  }
}

inspectPowerPortals();
