import axios from 'axios';
import * as cheerio from 'cheerio';

async function findEvnLink() {
  const res = await axios.get('https://www.evn.bg', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(res.data);
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (href.includes('prek') || href.includes('avarii') || href.includes('outage') || text.includes('прекъсв') || text.includes('авари') || text.includes('ток')) {
      console.log(`EVN link found: "${text}" => ${href}`);
    }
  });
}

findEvnLink();
