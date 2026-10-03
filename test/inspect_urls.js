import axios from 'axios';
import * as cheerio from 'cheerio';

async function inspect(name, baseUrl, url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      timeout: 6000
    });
    const $ = cheerio.load(res.data);
    console.log(`\n=== ${name} ===`);
    const found = [];
    $('a').each((i, el) => {
      let href = $(el).attr('href');
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (href) {
        if (!href.startsWith('http')) {
          href = baseUrl + (href.startsWith('/') ? '' : '/') + href;
        }
        if (text.length > 2 && (
          text.includes('авари') || text.includes('ремонт') || text.includes('спиран') ||
          text.includes('прекъсван') || text.includes('новини') || text.includes('съобщен') ||
          text.includes('информац') || href.includes('avarii') || href.includes('news') || href.includes('remont')
        )) {
          if (!found.includes(href)) {
            found.push(href);
            console.log(`  -> [${text}] ${href}`);
          }
        }
      }
    });
  } catch (err) {
    console.log(`Error inspecting ${name}:`, err.message);
  }
}

async function main() {
  await inspect('ВиК Йовковци (Велико Търново)', 'https://vik-vt.com', 'https://vik-vt.com/');
  await inspect('ВиК Бургас', 'https://vik-burgas.com', 'https://vik-burgas.com/');
  await inspect('ВиК Русе', 'https://www.vik-ruse.com', 'https://www.vik-ruse.com/');
  await inspect('Софийска вода', 'https://www.sofiyskavoda.bg', 'https://www.sofiyskavoda.bg/');
  await inspect('Електрохолд', 'https://electrohold.bg', 'https://electrohold.bg/');
  await inspect('Топлофикация София', 'https://toplo.bg', 'https://toplo.bg/');
}

main();
