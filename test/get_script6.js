import axios from 'axios';
import * as cheerio from 'cheerio';

async function getInlineScript6() {
  const res = await axios.get('https://erpsever.bg/bg/prekysvanija', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(res.data);
  $('script:not([src])').each((i, el) => {
    const text = $(el).html() || '';
    if (text.includes('interruption_areas') || text.includes('loadInterruptions')) {
      console.log(`Script content:\n`, text);
    }
  });
}

getInlineScript6();
