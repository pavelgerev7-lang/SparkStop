import axios from 'axios';

async function testSofiaWithReferer() {
  const layerIds = [1, 2, 3, 4];
  for (const id of layerIds) {
    try {
      const url = `https://gispx.sofiyskavoda.bg/arcgis/rest/services/WSI_PUBLIC/InfoCenter_Public/MapServer/${id}/query?where=1%3D1&outFields=*&f=json`;
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://gispx.sofiyskavoda.bg/WebApp.InfoCenter/?a=0&tab=0',
          'Origin': 'https://gispx.sofiyskavoda.bg'
        },
        timeout: 6000
      });
      console.log(`\n=== Layer ${id} (Features: ${res.data.features ? res.data.features.length : 0}) ===`);
      if (res.data.features && res.data.features.length > 0) {
        console.log('Features count:', res.data.features.length);
        console.log('Sample feature:', JSON.stringify(res.data.features[0], null, 2));
      }
    } catch (e) {
      console.log(`Err on ${id}: ${e.message}`);
    }
  }
}

testSofiaWithReferer();
