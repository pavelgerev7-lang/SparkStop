import axios from 'axios';

async function testAllRegions() {
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

  for (const reg of regions) {
    try {
      const url = `https://erpsever.bg/bg/profil/xhr/?method=get_interruptions&region_id=${reg.id}&type=all_active&offset=0`;
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://erpsever.bg/bg/prekysvanija'
        },
        timeout: 5000
      });
      const match = res.data.find(a => a.area_id == reg.id);
      const locCount = match?.area_locations?.length || 0;
      console.log(`✅ [${reg.name} - ID ${reg.id}] Found ${locCount} active outages!`);
      if (locCount > 0) {
        console.log(`   Sample Period: ${match.area_locations[0].location_period}`);
        console.log(`   Sample Text: ${match.area_locations[0].location_text?.substring(0, 180)}...`);
      }
    } catch (e) {
      console.error(`❌ Region ${reg.name} error:`, e.message);
    }
  }
}

testAllRegions();
