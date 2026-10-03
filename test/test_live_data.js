import axios from 'axios';
import * as cheerio from 'cheerio';

async function testActiveOutages() {
  // 1. Sofiyska Voda
  try {
    const svRes = await axios.get('https://sofiyskavoda.bg/water-stops', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000
    });
    const $ = cheerio.load(svRes.data);
    console.log('--- Софийска вода ---');
    $('.water-stop-item, .view-water-stops .views-row, tr, .water-stop, p').each((i, el) => {
      const txt = $(el).text().replace(/\s+/g, ' ').trim();
      if (txt.includes('спиране') || txt.includes('ремонт') || txt.includes('авария') || txt.includes('водоподаване')) {
        console.log(`[SV ${i}] ${txt.substring(0, 150)}`);
      }
    });
  } catch (e) {
    console.log('SV error:', e.message);
  }

  // 2. ViK Varna
  try {
    const vvRes = await axios.get('https://vikvarna.com/bg/avarii.html', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000
    });
    const $ = cheerio.load(vvRes.data);
    console.log('\n--- ВиК Варна ---');
    $('table tr, .avarii-item, p, div.content').each((i, el) => {
      const txt = $(el).text().replace(/\s+/g, ' ').trim();
      if (txt.includes('авария') || txt.includes('ремонт') || txt.includes('район') || txt.includes('до')) {
        console.log(`[VV ${i}] ${txt.substring(0, 150)}`);
      }
    });
  } catch (e) {
    console.log('VV error:', e.message);
  }

  // 3. ViK Plovdiv
  try {
    const vpRes = await axios.get('https://vik.bg/novini', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000
    });
    const $ = cheerio.load(vpRes.data);
    console.log('\n--- ВиК Пловдив ---');
    $('article, .news-item, .post, tr, p').each((i, el) => {
      const txt = $(el).text().replace(/\s+/g, ' ').trim();
      if (txt.includes('авария') || txt.includes('ремонт') || txt.includes('водоподаване')) {
        console.log(`[VP ${i}] ${txt.substring(0, 150)}`);
      }
    });
  } catch (e) {
    console.log('VP error:', e.message);
  }
}

testActiveOutages();
