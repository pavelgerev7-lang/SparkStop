import fs from 'fs';
import path from 'path';

const DB_FILE = path.resolve('data/local_db.json');
const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));

const deviceId = '731b9c35-438a-4022-b3a8-95498838900d';

// Ensure user has the sample address
const sampleAddress = {
  id: 'addr-sample-shumen-test',
  user_id: deviceId,
  label: 'Тест Шумен',
  city: 'Шумен',
  street_name: 'ул. Генерал Драгомиров 154',
  district: 'кв. Боян Българанов',
  lat: 43.275,
  lng: 26.920,
  created_at: new Date().toISOString()
};

data.saved_addresses = data.saved_addresses.filter(a => a.id !== 'addr-sample-shumen-test');
data.saved_addresses.push(sampleAddress);

const now = new Date();
const sampleOutage = {
  id: 'outage-active-test-shumen-1137',
  utility_type: 'water',
  provider: 'ВиК Шумен',
  city: 'Шумен',
  raw_location_text: 'Съобщение от ВиК Шумен (22 авг. 2026): Авария на ул. Генерал Драгомиров 154 в кв. Боян Българанов. Спряно водоподаване в района на ул. Генерал Драгомиров, ул. Генерал Тотлебен, ул. Дунав, ул. Бели Лом, ул. Искър.',
  affected_streets: [
    'ул. Генерал Драгомиров 154',
    'ул. Генерал Драгомиров',
    'ул. Генерал Тотлебен',
    'ул. Дунав',
    'ул. Бели Лом',
    'ул. Искър'
  ],
  lat: 43.275,
  lng: 26.920,
  start_time: new Date(now.getTime() - 1 * 3600000).toISOString(),
  expected_end_time: new Date(now.getTime() + 3.5 * 3600000).toISOString(),
  status: 'active',
  source_url: 'https://www.vik-shumen.net/saobshtenie-1137/',
  created_at: now.toISOString(),
  updated_at: now.toISOString()
};

data.outages = data.outages.filter(o => o.id !== 'outage-active-test-shumen-1137');
data.outages.unshift(sampleOutage);

fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
console.log('✅ Injected sample active outage and saved address successfully!');
