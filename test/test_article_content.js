import axios from 'axios';
import * as cheerio from 'cheerio';

async function testArticle(url) {
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(res.data);
    const title = $('h1, h2').first().text().trim();
    let body = '';
    $('p, .content, .entry-content, article').each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t.length > 20) body += ' ' + t;
    });
    console.log(`\n========================================`);
    console.log(`URL: ${url}`);
    console.log(`Title: ${title}`);
    console.log(`Body: ${body.trim()}`);
  } catch (err) {
    console.error(`Error fetching ${url}:`, err.message);
  }
}

async function main() {
  await testArticle('https://www.vik-vt.com/avarien-remont-gr-veliko-tiernovo-119');
  await testArticle('https://www.vik-vt.com/avarien-remont-gr-veliko-tiernovo-118');
  await testArticle('https://www.vik-vt.com/planov-remont-s-draganovo-2');
}

main();
