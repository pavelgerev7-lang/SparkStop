import axios from 'axios';

async function testSofiaArcGis() {
  const layerIds = [1, 2, 3, 4];
  for (const id of layerIds) {
    try {
      const url = `https://gispx.sofiyskavoda.bg/arcgis/rest/services/WSI_PUBLIC/InfoCenter_Public/MapServer/${id}/query?where=1%3D1&outFields=*&f=json`;
      const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000 });
      console.log(`\n=== Layer ${id} Count: ${res.data.features ? res.data.features.length : 0} ===`);
      if (res.data.features && res.data.features.length > 0) {
        console.log('Sample feature attributes:', JSON.stringify(res.data.features[0].attributes, null, 2));
      }
    } catch (e) {
      console.log(`Error layer ${id}: ${e.message}`);
    }
  }
}

testSofiaArcGis();
