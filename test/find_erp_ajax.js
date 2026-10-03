import axios from 'axios';
import * as cheerio from 'cheerio';

async function findErpSeverAjax() {
  const res = await axios.get('https://erpsever.bg/bg/prekysvanija', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(res.data);
  $('script[src]').each((_, el) => {
    console.log('Script URL:', $(el).attr('src'));
  });

  // Check inline JS
  $('script:not([src])').each((i, el) => {
    const text = $(el).html() || '';
    if (text.includes('mf') || text.includes('ajax') || text.includes('change') || text.includes('oblast') || text.includes('fetch') || text.includes('url')) {
      console.log(`\nInline Script #${i}:\n`, text);
    }
  });
}

findErpSeverAjax();
