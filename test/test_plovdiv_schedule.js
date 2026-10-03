import axios from 'axios';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';

async function testPlovdivSchedule() {
  const url = 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung4.asp';
  const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'arraybuffer' });
  const html = iconv.decode(res.data, 'windows-1251');
  const $ = cheerio.load(html);
  console.log('Title:', $('title').text());
  console.log('Total table rows:', $('tr').length);
  $('tr').slice(0, 15).each((i, tr) => {
    const cells = $(tr).find('td, th').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length > 0) {
      console.log(`Row #${i}:`, cells.join(' | '));
    }
  });
}

testPlovdivSchedule();
