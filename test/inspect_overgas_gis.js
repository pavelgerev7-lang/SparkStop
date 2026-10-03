async function inspectOvergasGis() {
  try {
    const res = await fetch('https://www.overgas.bg/planirani-remonti-i-avarii/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await res.text();
    console.log('Overgas HTML length:', html.length);
    
    // Look for arcgis, featurelayer, rest/services, iframe, json endpoints
    const regex = /(https?:\/\/[^"' \t\r\n]+(arcgis|esri|featurelayer|MapServer|FeatureServer|api|rest\/services)[^"' \t\r\n]*)/gi;
    const matches = html.match(regex) || [];
    console.log('Overgas GIS / API matches:');
    console.log([...new Set(matches)]);

    // Check all iframes and scripts
    const scriptRegex = /<script[^>]+src=["']([^"']+)["']/gi;
    let sMatch;
    while ((sMatch = scriptRegex.exec(html)) !== null) {
      console.log('Script:', sMatch[1]);
    }

    const iframeRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
    let iMatch;
    while ((iMatch = iframeRegex.exec(html)) !== null) {
      console.log('Iframe:', iMatch[1]);
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

inspectOvergasGis();
