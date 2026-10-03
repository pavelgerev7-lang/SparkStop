import axios from 'axios';
import * as cheerio from 'cheerio';

async function testFetchRegionData() {
  console.log('--- 1. Testing ERP Sever Region Submissions ---');
  // Inspect form action and inputs on ERP Sever
  const res = await axios.get('https://erpsever.bg/bg/prekysvanija', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(res.data);
  $('form').each((i, el) => {
    console.log(`Form #${i} Action: ${$(el).attr('action')}, Method: ${$(el).attr('method')}`);
    $(el).find('input, select').each((_, inp) => {
      console.log(`  Input: name=${$(inp).attr('name')}, type=${$(inp).attr('type')}, value=${$(inp).attr('value')}`);
    });
  });

  // Let's also check if there are option values in select
  $('select[name="mf"] option').each((_, el) => {
    console.log(`Option: val="${$(el).attr('value')}", text="${$(el).text().trim()}"`);
  });

  // Test submitting for Veliko Tarnovo, Varna, Ruse
  const vtVal = $('select[name="mf"] option:contains("Велико Търново")').attr('value') || '2';
  try {
    const postRes = await axios.post('https://erpsever.bg/bg/prekysvanija', new URLSearchParams({
      'mf': vtVal
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0'
      }
    });
    console.log(`POST response status: ${postRes.status}, length: ${postRes.data.length}`);
    const $p = cheerio.load(postRes.data);
    console.log('Outage table/items found:', $p('.table, table, .outage-item, .schedule-item, tr').length);
    $p('tr, .item, p').slice(0, 10).each((_, tr) => {
      const txt = $p(tr).text().replace(/\s+/g, ' ').trim();
      if (txt.length > 20) console.log(`Sample row: ${txt}`);
    });
  } catch (e) {
    console.error('POST test failed:', e.message);
  }

  console.log('\n--- 2. Testing EP Yug Planned Shutdowns ---');
  try {
    const elyugRes = await axios.get('https://www.elyug.bg/Customers/Planned_shutdowns.aspx', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const $e = cheerio.load(elyugRes.data);
    console.log('EP Yug Planned Title:', $e('title').text().trim());
    console.log('Forms on EP Yug Planned:', $e('form').length);
    $e('table, .schedule, .outages, tr, p').slice(0, 10).each((_, el) => {
      const txt = $e(el).text().replace(/\s+/g, ' ').trim();
      if (txt.length > 25 && (txt.includes('Пловдив') || txt.includes('прекъсв') || txt.includes('час') || txt.includes('ул.'))) {
        console.log(`EP Yug snippet: ${txt}`);
      }
    });
  } catch (e) {
    console.error('EP Yug planned failed:', e.message);
  }
}

testFetchRegionData();
