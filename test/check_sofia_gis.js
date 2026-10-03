import axios from 'axios';

async function checkGis() {
  try {
    const res = await axios.get('https://gispx.sofiyskavoda.bg/WebApp.InfoCenter/?a=0&tab=0', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    });
    console.log('GIS status:', res.status);
    console.log('GIS body sample:', res.data.substring(0, 800));
    
    // Check for API endpoints or json endpoints
    const matches = res.data.match(/https?:\/\/[^"'\s]+\/(?:arcgis|api|rest|services)[^"'\s]*/gi) || [];
    console.log('GIS API endpoints:', matches);
  } catch (e) {
    console.error('GIS Error:', e.message);
  }
}

checkGis();
