import axios from 'axios';
import * as cheerio from 'cheerio';

async function findExactPowerUrls() {
  const evnCandidates = [
    'https://www.evn.bg',
    'https://www.evn.bg/Home/Outages.aspx',
    'https://www.evn.bg/bg/Outages',
    'https://www.evn.bg/Home/Electricity/Outages.aspx',
    'https://www.evn.bg/Client-portal/Outages.aspx',
    'https://www.evn.bg/Outages'
  ];

  const ermCandidates = [
    'https://ermzapad.bg',
    'https://ermzapad.bg/bg/prekysvanija',
    'https://ermzapad.bg/bg/prekusvaniya',
    'https://ermzapad.bg/bg/za-klienta/prekysvanija',
    'https://info.ermzapad.bg'
  ];

  const erpCandidates = [
    'https://erpsever.bg',
    'https://erpsever.bg/bg/prekysvanija',
    'https://erpsever.bg/bg/planirani-prekysvanija',
    'https://erpsever.bg/bg/grafik-prekysvanija'
  ];

  console.log('--- TESTING EVN ---');
  for (const u of evnCandidates) {
    try {
      const res = await axios.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
      const $ = cheerio.load(res.data);
      const title = $('title').text().trim();
      console.log(`EVN: ${u} => ${res.status} [${title}]`);
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const t = $(el).text().trim();
        if (href.includes('outage') || href.includes('prek') || href.includes('avarii') || t.includes('прекъсв') || t.includes('авари')) {
          console.log(`  -> EVN link: ${t} (${href})`);
        }
      });
    } catch (e) {
      console.log(`EVN fail ${u}: ${e.message}`);
    }
  }

  console.log('\n--- TESTING ERM ZAPAD ---');
  for (const u of ermCandidates) {
    try {
      const res = await axios.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
      const $ = cheerio.load(res.data);
      const title = $('title').text().trim();
      console.log(`ERM: ${u} => ${res.status} [${title}]`);
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const t = $(el).text().trim();
        if (href.includes('prek') || href.includes('avarii') || t.includes('прекъсв') || t.includes('авари')) {
          console.log(`  -> ERM link: ${t} (${href})`);
        }
      });
    } catch (e) {
      console.log(`ERM fail ${u}: ${e.message}`);
    }
  }

  console.log('\n--- TESTING ERP SEVER ---');
  for (const u of erpCandidates) {
    try {
      const res = await axios.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
      const $ = cheerio.load(res.data);
      const title = $('title').text().trim();
      console.log(`ERP: ${u} => ${res.status} [${title}]`);
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const t = $(el).text().trim();
        if (href.includes('prek') || href.includes('avarii') || t.includes('прекъсв') || t.includes('авари') || t.includes('планирани')) {
          console.log(`  -> ERP link: ${t} (${href})`);
        }
      });
    } catch (e) {
      console.log(`ERP fail ${u}: ${e.message}`);
    }
  }
}

findExactPowerUrls();
