async function findAresgasRepairLink() {
  try {
    const res = await fetch('https://www.aresgas.bg/%d0%b7%d0%b0-%d0%ba%d0%be%d0%bc%d0%bf%d0%b0%d0%bd%d0%b8%d1%8f%d1%82%d0%b0/%d0%bd%d0%be%d0%b2%d0%b8%d0%bd%d0%b8/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await res.text();
    console.log('HTML length:', html.length);
    
    // Look for all links that contain repair or avarii or text around "АВАРИИ И РЕМОНТИ"
    const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const url = match[1];
      const text = match[2].replace(/<[^>]+>/g, '').trim();
      if (text.toLowerCase().includes('авари') || text.toLowerCase().includes('ремонт') || url.includes('avarii') || url.includes('remont')) {
        console.log(`FOUND LINK -> URL: "${url}" | TEXT: "${text}"`);
      }
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

findAresgasRepairLink();
