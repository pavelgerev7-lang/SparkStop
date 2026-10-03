import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'data', 'local_db.json');

function purgeGhostGasOutages() {
  if (!fs.existsSync(dbPath)) return;
  const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

  const initialCount = data.outages.length;
  data.outages = data.outages.filter(o => {
    const isGas = o.utility_type === 'gas' || (o.provider && o.provider.toLowerCase().includes('газ'));
    if (!isGas) return true;

    const raw = (o.raw_location_text || '').toLowerCase();
    const isGhost = 
      raw.includes('диспечерски център') ||
      raw.includes('аварийна линия на аресгаз') ||
      raw.includes('0700 10 500') ||
      raw.includes('0700 11 110') ||
      raw.includes('планирани ремонти и аварии –––') ||
      raw.includes('към момента няма') ||
      raw.includes('няма аварийни спирания') ||
      raw.trim() === 'планирани ремонти и аварии' ||
      raw.trim() === 'планирани ремонти и аварии ––––––––––––––';

    return !isGhost;
  });

  const removed = initialCount - data.outages.length;
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Purged ${removed} ghost/false gas records from database. Remaining outages: ${data.outages.length}`);
}

purgeGhostGasOutages();
