import assert from 'assert';
import { searchSettlements, BULGARIAN_SETTLEMENTS } from '../src/utils/bulgarianSettlements.js';
import { saveUserAddress, getUserAddresses, deleteUserAddress } from '../src/services/addressService.js';

async function runTests() {
  console.log('--- 🧪 Testing Comprehensive Bulgarian Settlements & Duplicate Villages ---');

  // 1. Test total settlements count
  assert(BULGARIAN_SETTLEMENTS.length >= 200, `Expected at least 200 settlements, found ${BULGARIAN_SETTLEMENTS.length}`);
  console.log(`✓ Total registered settlements in database: ${BULGARIAN_SETTLEMENTS.length}`);

  // 2. Test duplicate village "Марково" (in Rodopi / Plovdiv vs Kaspichan / Shumen)
  const markovoResults = searchSettlements('марково');
  console.log(`✓ Search "марково" results:`, markovoResults.map(r => r.display_label));
  assert(markovoResults.length >= 2, 'Expected at least 2 results for village Markovo');
  assert(markovoResults.some(r => r.municipality === 'Родопи' && r.region === 'Пловдив'), 'Missing Markovo (Rodopi, Plovdiv)');
  assert(markovoResults.some(r => r.municipality === 'Каспичан' && r.region === 'Шумен'), 'Missing Markovo (Kaspichan, Shumen)');

  // 3. Test duplicate village "Ново село" (in Vidin, Veliko Tarnovo, Stamboliyski, Troyan, Samokov, etc.)
  const novoSeloResults = searchSettlements('ново село');
  console.log(`✓ Search "ново село" results count: ${novoSeloResults.length}`);
  assert(novoSeloResults.length >= 3, 'Expected at least 3 duplicate Novo Selo villages');
  novoSeloResults.forEach(r => console.log(`   - ${r.display_label}`));

  // 4. Test duplicate village "Александрово"
  const alexResults = searchSettlements('александрово');
  console.log(`✓ Search "александрово" results count: ${alexResults.length}`);
  assert(alexResults.length >= 3, 'Expected at least 3 duplicate Alexandrovo villages');
  alexResults.forEach(r => console.log(`   - ${r.display_label}`));

  // 5. Test saving user address with municipality and region
  const testUserId = `test-user-${Date.now()}`;
  const saved = await saveUserAddress({
    user_id: testUserId,
    label: 'Къща на село',
    city: 'Марково',
    municipality: 'Родопи',
    region: 'Пловдив',
    street_name: 'ул. Захари Стоянов 14',
    lat: 42.0625,
    lng: 24.7028
  });

  assert.strictEqual(saved.municipality, 'Родопи');
  assert.strictEqual(saved.region, 'Пловдив');
  assert.strictEqual(saved.city, 'Марково');
  console.log('✓ Successfully saved user address with Municipality (Родопи) and Region (Пловдив):', saved);

  // 6. Test retrieving user addresses
  const userAddresses = await getUserAddresses(testUserId);
  assert.strictEqual(userAddresses.length, 1);
  assert.strictEqual(userAddresses[0].municipality, 'Родопи');
  console.log('✓ Successfully retrieved user addresses with accurate administrative details');

  // Clean up
  await deleteUserAddress(saved.id, testUserId);
  console.log('✓ Cleaned up test address');

  console.log('🎉 ALL SETTLEMENT, MUNICIPALITY, AND ADDRESS TESTS PASSED 100%!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
