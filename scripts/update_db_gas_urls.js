import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'data', 'local_db.json');

function updateDbGasUrls() {
  if (!fs.existsSync(dbPath)) return;
  const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

  let updatedCount = 0;
  if (Array.isArray(data.outages)) {
    data.outages.forEach(o => {
      const prov = (o.provider || '').toLowerCase();
      const city = (o.city || '').toLowerCase();
      const isGas = o.utility_type === 'gas' || prov.includes('газ');

      if (isGas) {
        if (prov.includes('аресгаз') || ['плевен', 'враца', 'благоевград', 'монтана', 'добрич'].some(cn => city.includes(cn))) {
          o.source_url = 'https://www.aresgas.bg/infocenter/';
          updatedCount++;
        } else {
          o.source_url = 'https://www.overgas.bg/planirani-remonti-i-avarii/';
          updatedCount++;
        }
      }
    });
  }

  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Successfully updated ${updatedCount} gas outage records to direct official repair pages.`);
}

updateDbGasUrls();
