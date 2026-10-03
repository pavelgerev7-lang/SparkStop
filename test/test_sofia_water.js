import axios from 'axios';
import * as cheerio from 'cheerio';

async function testSofiaWater() {
  try {
    const urls = [
      'https://www.sofiyskavoda.bg/water-stops',
      'https://www.sofiyskavoda.bg/water_stops.aspx',
      'https://www.sofiyskavoda.bg'
    ];
    for (const u of urls) {
      try {
        const res = await axios.get(u, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 6000
        });
        console.log(`\n=== URL: ${u} (Status: ${res.status}, Length: ${res.data.length}) ===`);
        const $ = cheerio.load(res.data);
        const title = $('title').text();
        console.log(`Page Title: ${title}`);
        
        // Find links and stoppage elements
        $('a').each((_, el) => {
          const href = $(el).attr('href') || '';
          const text = $(el).text().replace(/\s+/g, ' ').trim();
          if (href.includes('stop') || href.includes('remont') || href.includes('avarii') || text.includes('спиране') || text.includes('ремонт') || text.includes('авария')) {
            console.log(`Link: ${text} -> ${href}`);
          }
        });

        $('.stoppage, .outage, .item, .news, article, tr').slice(0, 10).each((_, el) => {
          const t = $(el).text().replace(/\s+/g, ' ').trim();
          if (t.length > 20 && (t.includes('ул.') || t.includes('кв.') || t.includes('ж.к.') || t.includes('бул.') || t.includes('спиране') || t.includes('водоподаване'))) {
            console.log(`Item snippet: ${t.substring(0, 120)}...`);
          }
        });
      } catch (err) {
        console.log(`Error on ${u}: ${err.message}`);
      }
    }
  } catch (e) {
    console.error('Fatal:', e);
  }
}

testSofiaWater();
