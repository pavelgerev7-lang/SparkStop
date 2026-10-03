import axios from 'axios';
import * as cheerio from 'cheerio';

const targets = [
  { name: 'Софийска вода', url: 'https://sofiyskavoda.bg/water-stops' },
  { name: 'Електрохолд (ЕРМ Запад)', url: 'https://ermzapad.bg/bg/za-klienta/prekysvvaniq/' },
  { name: 'ЕРП Север (Непланирани)', url: 'https://erpsever.bg/bg/neplanirani-prekysvaniq' },
  { name: 'ЕРП Север (Планирани)', url: 'https://erpsever.bg/bg/planirani-prekysvaniq' },
  { name: 'EVN (Електроразпределение Юг)', url: 'https://www.elyug.bg/bg/planirani-izkliuchvaniia' },
  { name: 'ВиК Варна', url: 'https://vikvarna.com/bg/avarii.html' },
  { name: 'ВиК Бургас', url: 'https://vik-burgas.com/' },
  { name: 'ВиК Пловдив', url: 'https://vik.bg/novini' },
  { name: 'ВиК Русе', url: 'https://vik-ruse.com/' },
  { name: 'ВиК Стара Загора', url: 'https://vik-stara-zagora.com/' },
  { name: 'Топлофикация София', url: 'https://toplo.bg/grafik-remonti' }
];

async function probe() {
  for (const t of targets) {
    try {
      const res = await axios.get(t.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
        timeout: 6000
      });
      console.log(`\n✅ [${t.name}] Status: ${res.status}, Length: ${res.data.length}`);
      const $ = cheerio.load(res.data);
      const textSample = $('body').text().replace(/\s+/g, ' ').substring(0, 300);
      console.log(`   Sample: ${textSample}`);
    } catch (err) {
      console.log(`\n❌ [${t.name}] Error: ${err.message}`);
    }
  }
}

probe();
