import axios from 'axios';

async function testErpSeverJsonEndpoint() {
  const url = 'https://erpsever.bg/bg/profil/xhr/?method=get_interruptions&region_id=0&type=all_active&offset=0';
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://erpsever.bg/bg/prekysvanija'
      }
    });

    console.log('Status:', res.status);
    console.log('Is Array?', Array.isArray(res.data), 'Length:', res.data.length);
    
    // Inspect areas
    for (const area of res.data) {
      console.log(`\n📍 [Area ${area.area_id}] ${area.area_title}: ${area.area_locations?.length || 0} locations`);
      if (area.area_locations && area.area_locations.length > 0) {
        console.log('  Sample Period:', area.area_locations[0].location_period);
        console.log('  Sample Text:', area.area_locations[0].location_text?.substring(0, 150));
      }
    }
  } catch (e) {
    console.error('Error fetching ERP Sever JSON:', e.message);
  }
}

testErpSeverJsonEndpoint();
