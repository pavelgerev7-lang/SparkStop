import axios from 'axios';

async function fetchGisJs() {
  try {
    const urls = [
      'https://gispx.sofiyskavoda.bg/WebApp.InfoCenter/js/alertsTab.js',
      'https://gispx.sofiyskavoda.bg/WebApp.InfoCenter/js/homePage.js',
      'https://gispx.sofiyskavoda.bg/WebApp.InfoCenter/js/config.js',
      'https://gispx.sofiyskavoda.bg/WebApp.InfoCenter/config.js'
    ];
    for (const u of urls) {
      try {
        const res = await axios.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000 });
        console.log(`\n=== Found ${u} (Length: ${res.data.length}) ===`);
        const matches = res.data.match(/https?:\/\/[^"'\s\)]+/g) || [];
        console.log('URLs inside:', matches.filter(m => !m.includes('w3.org') && !m.includes('jquery') && !m.includes('esri')));
        const layerMatches = res.data.match(/[a-zA-Z0-9_]+LayerUrl\s*=\s*["'][^"']+["']/g) || [];
        console.log('Layer URLs:', layerMatches);
      } catch (e) {
        console.log(`Failed ${u}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(e);
  }
}

fetchGisJs();
