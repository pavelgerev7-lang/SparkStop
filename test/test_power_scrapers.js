import axios from 'axios';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { parseOutageTextHeuristic, extractStreetsHeuristic, parseBulgarianDateTime } from '../src/services/aiParserService.js';
import { upsertOutage } from '../src/services/outageService.js';

export async function scrapeErpSeverLivePower() {
  console.log('⚡ [ERP SEVER] Fetching live power outages for all of Northern Bulgaria...');
  const regions = [
    { id: 1, name: 'Варна' },
    { id: 2, name: 'Велико Търново' },
    { id: 3, name: 'Габрово' },
    { id: 4, name: 'Добрич' },
    { id: 5, name: 'Разград' },
    { id: 6, name: 'Русе' },
    { id: 7, name: 'Силистра' },
    { id: 8, name: 'Търговище' },
    { id: 9, name: 'Шумен' }
  ];

  let totalParsed = 0;

  for (const reg of regions) {
    try {
      const url = `https://erpsever.bg/bg/profil/xhr/?method=get_interruptions&region_id=${reg.id}&type=all_active&offset=0`;
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://erpsever.bg/bg/prekysvanija'
        },
        timeout: 8000
      });

      const areaData = Array.isArray(res.data) ? res.data.find(a => a.area_id == reg.id) : null;
      if (!areaData || !Array.isArray(areaData.area_locations)) continue;

      for (const loc of areaData.area_locations) {
        const rawText = `${loc.location_period || ''} ${loc.location_text || ''}`.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!rawText || rawText.length < 15) continue;

        // Parse streets and timings
        const parsed = parseOutageTextHeuristic(rawText, 'Енерго-Про (ЕРП Север)', reg.name, 'https://erpsever.bg/bg/prekysvanija');
        
        await upsertOutage({
          utility_type: 'electricity',
          provider: 'Енерго-Про (ЕРП Север)',
          city: parsed.city || reg.name,
          raw_location_text: rawText,
          affected_streets: parsed.affected_streets,
          source_url: 'https://erpsever.bg/bg/prekysvanija',
          start_time: parsed.start_time,
          expected_end_time: parsed.expected_end_time,
          status: parsed.status
        });
        totalParsed++;
      }
    } catch (e) {
      console.error(`Error scraping ERP Sever region ${reg.name}:`, e.message);
    }
  }

  console.log(`✅ [ERP SEVER FINISHED] Successfully imported ${totalParsed} live power outages across Northern Bulgaria.`);
  return totalParsed;
}

export async function scrapeElYugLivePower() {
  console.log('⚡ [EP YUG] Fetching live power outages for all of Southern Bulgaria...');
  const regions = [
    { id: 4, name: 'Пловдив', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung4.asp' },
    { id: 1, name: 'Бургас', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung1.asp' },
    { id: 7, name: 'Стара Загора', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung7.asp' },
    { id: 3, name: 'Пазарджик', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung3.asp' },
    { id: 5, name: 'Сливен', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung5.asp' },
    { id: 8, name: 'Хасково', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung8.asp' },
    { id: 9, name: 'Ямбол', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung9.asp' },
    { id: 6, name: 'Смолян', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung6.asp' },
    { id: 2, name: 'Кърджали', url: 'https://www.elyug.bg/oldservices/ec_ep/abschaltung_bg/abschaltung2.asp' }
  ];

  let totalParsed = 0;

  for (const reg of regions) {
    try {
      const res = await axios.get(reg.url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        responseType: 'arraybuffer',
        timeout: 8000
      });
      const html = iconv.decode(res.data, 'windows-1251');
      const $ = cheerio.load(html);

      let currentAddresses = '';
      let currentTime = '';
      let currentDate = '';

      $('tr').each(async (_, tr) => {
        const text = $(tr).text().replace(/\s+/g, ' ').trim();
        if (text.includes('Адрес(и) |') || text.startsWith('Адрес(и)')) {
          currentAddresses = text.replace(/Адрес\(и\)\s*\|?\s*/i, '').trim();
        }
        if (text.includes('Срок на изключването от / до |') || text.startsWith('Срок на изключването')) {
          currentTime = text.replace(/Срок на изключването от \/ до\s*\|?\s*/i, '').trim();
        }
        if (text.includes('Дата(и) на изключването |') || text.startsWith('Дата(и) на изключването')) {
          currentDate = text.replace(/Дата\(и\) на изключването\s*\|?\s*/i, '').trim();

          if (currentAddresses && currentAddresses.length > 10) {
            const rawAnnouncement = `Планирано изключване на електрозахранването в Област ${reg.name}. Дата: ${currentDate}. Час: ${currentTime}. Адреси: ${currentAddresses}`;
            const parsed = parseOutageTextHeuristic(rawAnnouncement, 'EVN България', reg.name, reg.url);

            await upsertOutage({
              utility_type: 'electricity',
              provider: 'EVN България',
              city: reg.name,
              raw_location_text: rawAnnouncement,
              affected_streets: parsed.affected_streets,
              source_url: reg.url,
              start_time: parsed.start_time,
              expected_end_time: parsed.expected_end_time,
              status: parsed.status
            });
            totalParsed++;
          }
          currentAddresses = '';
          currentTime = '';
          currentDate = '';
        }
      });
    } catch (e) {
      console.error(`Error scraping EP Yug region ${reg.name}:`, e.message);
    }
  }

  console.log(`✅ [EP YUG FINISHED] Successfully imported ${totalParsed} live power outages across Southern Bulgaria.`);
  return totalParsed;
}

// Run test
async function runAllLiveScrapes() {
  await scrapeErpSeverLivePower();
  await scrapeElYugLivePower();
}

runAllLiveScrapes();
