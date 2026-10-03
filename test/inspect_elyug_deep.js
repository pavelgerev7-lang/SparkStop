import axios from 'axios';
import * as cheerio from 'cheerio';

async function inspectElYugDeep() {
  const pages = [
    'https://www.elyug.bg/Customers/Planned_shutdowns.aspx',
    'https://www.elyug.bg/Customers/Unscheduled-power-cuts.aspx'
  ];

  for (const p of pages) {
    try {
      const res = await axios.get(p, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 7000 });
      console.log(`\n=== EP YUG: ${p} (Status: ${res.status}, Length: ${res.data.length}) ===`);
      const $ = cheerio.load(res.data);
      console.log('Title:', $('title').text());
      
      // Look for iframes, forms, tables, links, scripts
      $('iframe').each((_, el) => console.log('Iframe src:', $(el).attr('src')));
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const txt = $(el).text().trim();
        if (href.includes('outage') || href.includes('prek') || href.includes('grafik') || href.includes('plan') || href.includes('pdf') || href.includes('xls') || txt.includes('график') || txt.includes('списък') || txt.includes('Пловдив') || txt.includes('Бургас') || txt.includes('Стара Загора')) {
          console.log(`EP Yug link: "${txt}" -> ${href}`);
        }
      });
      $('script').each((_, el) => {
        const src = $(el).attr('src') || '';
        const html = $(el).html() || '';
        if (src.includes('outage') || html.includes('outage') || html.includes('prek') || html.includes('plovdiv')) {
          console.log('Script snippet:', html.substring(0, 300));
        }
      });
    } catch (e) {
      console.error('EP Yug deep failed:', e.message);
    }
  }
}

inspectElYugDeep();
