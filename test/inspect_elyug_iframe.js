import axios from 'axios';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';

async function inspectElYugIframe() {
  const url = 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung.asp';
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      responseType: 'arraybuffer',
      timeout: 7000
    });
    // Decode with windows-1251 or utf-8
    const decoded1251 = iconv.decode(res.data, 'windows-1251');
    console.log('EP Yug Iframe decoded length:', decoded1251.length);
    const $ = cheerio.load(decoded1251);
    console.log('Title/H1:', $('h1, h2, title').text().trim());
    console.log('Forms:', $('form').length);
    $('select').each((_, el) => {
      console.log(`Select [${$(el).attr('name')}]:`, $(el).find('option').map((_, o) => $(o).text().trim()).get().slice(0, 10));
    });
    $('table tr').slice(0, 10).each((_, tr) => {
      console.log('Row:', $(tr).text().replace(/\s+/g, ' ').trim());
    });
  } catch (e) {
    console.error('Iframe error:', e.message);
  }
}

inspectElYugIframe();
