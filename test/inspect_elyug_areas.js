import axios from 'axios';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';

async function inspectElYugAreas() {
  const url = 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung.asp';
  const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'arraybuffer' });
  const html = iconv.decode(res.data, 'windows-1251');
  const $ = cheerio.load(html);
  $('area, a').each((_, el) => {
    console.log(`Area href: ${$(el).attr('href')}, title: ${$(el).attr('title') || $(el).attr('alt') || $(el).text()}`);
  });
}

inspectElYugAreas();
