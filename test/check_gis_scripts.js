import axios from 'axios';

async function checkGisScripts() {
  const res = await axios.get('https://gispx.sofiyskavoda.bg/WebApp.InfoCenter/?a=0&tab=0', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const html = res.data;
  
  // Find config, js files, endpoints
  const jsFiles = html.match(/(?:src|href)=["']([^"']+\.js[^"']*)["']/gi) || [];
  console.log('JS files:', jsFiles);

  const urlMatches = html.match(/["'](\/(?:arcgis|rest|services)[^"']*)["']/gi) || [];
  console.log('Rest endpoints:', urlMatches);

  // Let's check config.js or app.js
  const configMatch = html.match(/config\s*:\s*\{[\s\S]+?\}/);
  if (configMatch) console.log('Config snippet:', configMatch[0].substring(0, 300));
}

checkGisScripts();
