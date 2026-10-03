async function testGas() {
  const gasUrls = [
    { name: 'Overgas Remonti', url: 'https://www.overgas.bg/planirani-remonti-i-avarii/' },
    { name: 'Overgas Novini', url: 'https://www.overgas.bg/novini/' },
    { name: 'Aresgas Home', url: 'https://www.aresgas.bg/' },
    { name: 'Aresgas Novini', url: 'https://www.aresgas.bg/novini/' },
    { name: 'Aresgas Dispecher', url: 'https://www.aresgas.bg/dispecherski-tsentar/' },
    { name: 'Aresgas Profilaktika', url: 'https://www.aresgas.bg/profilaktika-i-remonti/' },
    { name: 'Aresgas Aktualno', url: 'https://www.aresgas.bg/aktualno/' },
    { name: 'Aresgas Syobshtenia', url: 'https://www.aresgas.bg/syobshtenia/' },
    { name: 'Citygas', url: 'https://citygas.bg/' },
    { name: 'Balkangas', url: 'https://balkangas2000.com/' },
    { name: 'Kostinbrodgas', url: 'https://kostinbrodgas.bg/' }
  ];

  console.log('Testing Gas URLs:');
  for (const item of gasUrls) {
    try {
      const res = await fetch(item.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
      console.log(`[${res.status}] ${item.name} -> ${res.url}`);
    } catch (e) {
      console.log(`[ERR] ${item.name} -> ${e.message}`);
    }
  }
}

testGas();
