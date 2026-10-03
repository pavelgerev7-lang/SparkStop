async function findAresgasPages() {
  try {
    const res = await fetch('https://www.aresgas.bg/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    const text = await res.text();
    const regex = /href=["']([^"']+)["']/gi;
    let match;
    const links = [];
    while ((match = regex.exec(text)) !== null) {
      links.push(match[1]);
    }
    const unique = [...new Set(links)];
    console.log('Found', unique.length, 'links on aresgas.bg:');
    console.log(unique.filter(l => !l.startsWith('#') && !l.includes('wp-content') && !l.includes('wp-includes')));
  } catch (e) {
    console.error('Error:', e.message);
  }
}

findAresgasPages();
