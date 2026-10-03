import axios from 'axios';

async function listAllSofiaAlerts() {
  const url = `https://gispx.sofiyskavoda.bg/arcgis/rest/services/WSI_PUBLIC/InfoCenter_Public/MapServer/2/query?where=1%3D1&outFields=*&f=json`;
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://gispx.sofiyskavoda.bg/WebApp.InfoCenter/?a=0&tab=0',
      'Origin': 'https://gispx.sofiyskavoda.bg'
    }
  });

  console.log(`Total live alerts in Sofia: ${res.data.features.length}`);
  res.data.features.forEach((f, i) => {
    console.log(`[${i+1}] ${f.attributes.ALERTTYPE}: ${f.attributes.LOCATION} | Час: ${f.attributes.START_H}:${f.attributes.START_M} - ${f.attributes.END_H}:${f.attributes.END_M} | Статус: ${f.attributes.ACTIVESTATUS}`);
  });
}

listAllSofiaAlerts();
