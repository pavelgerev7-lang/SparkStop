import axios from 'axios';
import * as cheerio from 'cheerio';

async function checkElYug() {
  const urls = [
    'https://www.elyug.bg',
    'https://www.elyug.bg/bg/prekusvanija',
    'https://www.elyug.bg/bg/za-klienta/prekusvanija',
    'https://www.elyug.bg/bg/grafik-prekusvanija'
  ];

  for (const u of urls) {
    try {
      const res = await axios.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
      const $ = cheerio.load(res.data);
      console.log(`[EP Yug] ${u} => ${res.status} [${$('title').text().trim()}]`);
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const t = $(el).text().trim();
        if (href.includes('prek') || t.includes('прекъсв') || t.includes('авари') || t.includes('планирани')) {
          console.log(`  -> Link: ${t} (${href})`);
        }
      });
    } catch (e) {
      console.log(`Failed ${u}: ${e.message}`);
    }
  }
}

checkElYug();
