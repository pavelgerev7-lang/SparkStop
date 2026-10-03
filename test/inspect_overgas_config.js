async function inspectOvergasConfig() {
  try {
    const configUrl = 'https://gisportal.overgas.bg/EsriBg.Overgas.PublicInterruption/BaseProject/Config/public/config-overgas-public-Interruption.json';
    const res = await fetch(configUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await res.json();
    console.log('Overgas Config JSON keys:', Object.keys(json));
    console.log('Map layers/services:', JSON.stringify(json.map || json.layers || json.services || json, null, 2).slice(0, 2000));
  } catch (e) {
    console.error('Error fetching Overgas config:', e.message);
  }
}

inspectOvergasConfig();
