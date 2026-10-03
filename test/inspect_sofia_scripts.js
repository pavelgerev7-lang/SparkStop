import axios from 'axios';
import * as cheerio from 'cheerio';

async function inspectSofiaScripts() {
  const res = await axios.get('https://www.sofiyskavoda.bg/water-stops', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const $ = cheerio.load(res.data);
  $('script').each((_, el) => {
    const src = $(el).attr('src') || '';
    const content = $(el).html() || '';
    if (src) console.log('Script src:', src);
    if (content.includes('stops') || content.includes('water') || content.includes('lat') || content.includes('map') || content.includes('fetch') || content.includes('ajax')) {
      console.log('Script inline:', content.substring(0, 300));
    }
  });
}

inspectSofiaScripts();
