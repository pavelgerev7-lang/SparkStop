import axios from 'axios';
import * as cheerio from 'cheerio';

async function parseArticle(url) {
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(res.data);
    console.log(`\n========================================`);
    console.log(`URL: ${url}`);
    $('h1, h2, h3, p').each((i, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t.includes('уведомява') || t.includes('авария') || t.includes('ремонт') || t.includes('водоподаване') || t.includes('вода') || t.includes('спиране')) {
        console.log(`📢 ${t}`);
      }
    });
  } catch (err) {
    console.log('Err:', err.message);
  }
}

async function main() {
  await parseArticle('https://www.vik-vt.com/avarien-remont-gr-veliko-tiernovo-118');
  await parseArticle('https://www.vik-vt.com/avarien-remont-gr-veliko-tiernovo-117');
  await parseArticle('https://www.vik-vt.com/avarien-remont-gr-veliko-tiernovo-116');
  await parseArticle('https://www.vik-vt.com/planov-remont-s-draganovo-2');
  await parseArticle('https://www.vik-vt.com/avarien-remont-s-maliek-ciflik');
}

main();
