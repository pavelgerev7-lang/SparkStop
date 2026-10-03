import fs from 'fs';
import path from 'path';

const DB_FILE = path.resolve('data/local_db.json');
const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));

// 1. Remove sample test address
data.saved_addresses = data.saved_addresses.filter(a => a.id !== 'addr-sample-shumen-test' && a.label !== 'Тест Шумен');

// 2. Remove sample test outages
data.outages = data.outages.filter(o => 
  o.id !== 'outage-sample-shumen-1137' && 
  o.id !== 'outage-active-test-shumen-1137' &&
  !o.city.includes('?') &&
  !o.provider.includes('?')
);

fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
console.log('✅ Removed sample test address and sample outages. Remaining saved addresses:', data.saved_addresses.length);
console.log('Current addresses in DB:', data.saved_addresses.map(a => `${a.label} (${a.city}: ${a.street_name})`));
