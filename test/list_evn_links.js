import axios from 'axios';
import * as cheerio from 'cheerio';

async function listAllEvnLinks() {
  const res = await axios.get('https://www.evn.bg', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(res.data);
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (href.length > 2 && text.length > 2) {
      console.log(`[EVN] ${text} => ${href}`);
    }
  });
}

listAllEvnLinks();
