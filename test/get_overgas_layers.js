async function getPublicInterruption() {
  try {
    const url = 'https://gisportal.overgas.bg/EsriBg.Overgas.PublicInterruption/BaseProject/Config/PublicInterruption.json';
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await res.json();
    console.log('PublicInterruption JSON layers:');
    console.log(JSON.stringify(json.operationalLayers || json, null, 2).slice(0, 2500));
  } catch (e) {
    console.error('Error:', e.message);
  }
}

getPublicInterruption();
