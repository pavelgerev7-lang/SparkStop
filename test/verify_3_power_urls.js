import axios from 'axios';

async function verifyAll3Urls() {
  const urls = [
    { name: 'EVN / EP Yug (Plovdiv, Burgas, etc.)', url: 'https://www.elyug.bg/SpecialPages/PowerOffLink.aspx' },
    { name: 'ERP Sever (Veliko Tarnovo, Varna, etc.)', url: 'https://erpsever.bg/bg/prekysvanija' },
    { name: 'ERM Zapad / Electrohold (Sofia, etc.)', url: 'https://ermzapad.bg/bg/za-klienta/prekusvania/' }
  ];

  for (const u of urls) {
    try {
      const res = await axios.get(u.url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 6000
      });
      console.log(`✅ [${u.name}] Status: ${res.status}, Length: ${res.data.length}`);
    } catch (e) {
      console.log(`❌ [${u.name}] Failed: ${e.message}`);
    }
  }
}

verifyAll3Urls();
