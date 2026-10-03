async function queryOvergasGis() {
  try {
    const url = 'https://gisportal.overgas.bg/arcgis/rest/services/OVERGAS_PUBLIC/PublicInterruption/MapServer/0/query?where=1%3D1&outFields=*&f=json';
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await res.json();
    console.log('Overgas Live Outage Features count:', json.features?.length);
    if (json.features && json.features.length > 0) {
      console.log('Sample feature:', JSON.stringify(json.features.slice(0, 5), null, 2));
    } else {
      console.log('Currently 0 active/scheduled gas outages in Overgas GIS across Bulgaria.');
    }
  } catch (e) {
    console.error('Error querying Overgas GIS:', e.message);
  }
}

queryOvergasGis();
