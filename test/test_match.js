import { checkAddressOutageStatus } from '../src/services/outageService.js';
import { inMemoryDB } from '../src/config/db.js';

async function test() {
  console.log('inMemoryDB outages count:', inMemoryDB.outages.length);
  inMemoryDB.outages.forEach(o => {
    console.log(`- Outage [${o.city}]: ${o.affected_streets.join(', ')} | Status: ${o.status} | End: ${o.expected_end_time}`);
  });

  const res1 = await checkAddressOutageStatus('ул. Съединение', 'Шумен');
  console.log('\nResult for ул. Съединение, Шумен:', res1.status_code, res1.status_label);

  const res2 = await checkAddressOutageStatus('ул. Генерал Драгомиров', 'Шумен');
  console.log('Result for ул. Генерал Драгомиров, Шумен:', res2.status_code, res2.status_label);
}

test();
