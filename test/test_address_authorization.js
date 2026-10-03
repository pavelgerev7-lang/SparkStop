// Address endpoints must only be changed by the account that owns them (guest/device ids have no account and stay open).
// Runs on the in-memory database (DATABASE_URL blanked before anything is imported), so it never touches production data.
process.env.DATABASE_URL = '';

const { saveAddressHandler, deleteAddressHandler, updateAddressNotificationHandler } = await import('../src/controllers/addressController.js');
const { generateAuthToken } = await import('../src/services/authService.js');
const { inMemoryDB } = await import('../src/config/db.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✅ PASS: ${name}`); passed++; } else { console.error(`  ❌ FAIL: ${name}`); failed++; }
}

const owner = inMemoryDB.users[0]; // the built-in demo account (UUID-shaped id, so it counts as a registered account)
const goodToken = generateAuthToken(owner);
const otherToken = generateAuthToken({ ...owner, id: '11111111-2222-3333-4444-555555555555', email: 'other@example.invalid' });

function call(handler, { body = {}, query = {}, params = {}, token = null } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); return this; }
    };
    const req = { body, query, params, headers: token ? { authorization: `Bearer ${token}` } : {} };
    Promise.resolve(handler(req, res, (err) => resolve({ status: 500, payload: { error: err && err.message } }))).catch((e) => resolve({ status: 500, payload: { error: e.message } }));
  });
}
const addr = (uid) => ({ user_id: uid, label: 'Тест', city: 'София', street_name: 'ул. Иван Вазов', region: 'София-град' });

console.log('🧪 ADDRESS AUTHORIZATION');
const before = inMemoryDB.saved_addresses.length;

console.log('\n🔹 Registered account');
let r = await call(saveAddressHandler, { body: addr(owner.id) });
assert(r.status === 403, `saving under an account id without a session is refused (${r.status})`);
r = await call(saveAddressHandler, { body: addr(owner.id), token: otherToken });
assert(r.status === 403, `saving with ANOTHER account's session is refused (${r.status})`);
r = await call(saveAddressHandler, { body: addr(owner.id), token: 'garbage' });
assert(r.status === 403, `saving with a bad token is refused (${r.status})`);
assert(inMemoryDB.saved_addresses.length === before, 'no address was written by the refused calls');
r = await call(saveAddressHandler, { body: addr(owner.id), token: goodToken });
assert(r.status === 201 && r.payload.data && r.payload.data.id, `the owner's own session saves (${r.status})`);
const savedId = r.payload.data && r.payload.data.id;

r = await call(updateAddressNotificationHandler, { params: { id: savedId }, body: { userId: owner.id, enabled: true, fcm_token: 'attacker-device' } });
assert(r.status === 403, `subscribing a device to someone else's address without their session is refused (${r.status})`);
r = await call(updateAddressNotificationHandler, { params: { id: savedId }, body: { userId: owner.id, enabled: true, fcm_token: 'my-device' }, token: goodToken });
assert(r.status === 200, `the owner may enable notifications (${r.status})`);

r = await call(deleteAddressHandler, { params: { id: savedId }, query: { userId: owner.id } });
assert(r.status === 403, `deleting someone else's address without their session is refused (${r.status})`);
r = await call(deleteAddressHandler, { params: { id: savedId }, query: { userId: owner.id }, token: otherToken });
assert(r.status === 403, `deleting with another account's session is refused (${r.status})`);
r = await call(deleteAddressHandler, { params: { id: savedId }, query: { userId: owner.id }, token: goodToken });
assert(r.status === 200, `the owner deletes their address (${r.status})`);

console.log('\n🔹 Guest (device id, no account)');
const guest = 'guest-device-1234567890';
r = await call(saveAddressHandler, { body: addr(guest) });
assert(r.status === 201, `a guest saves without any session (${r.status})`);
const guestAddr = r.payload.data && r.payload.data.id;
r = await call(deleteAddressHandler, { params: { id: guestAddr }, query: { userId: guest } });
assert(r.status === 200, `a guest deletes their own address (${r.status})`);

console.log('\n🔹 Bad input');
r = await call(saveAddressHandler, { body: { ...addr(guest), label: 'x'.repeat(500) } });
assert(r.status === 400, `an oversized label is rejected (${r.status})`);
r = await call(saveAddressHandler, { body: { ...addr(guest), city: { $gt: '' } } });
assert(r.status === 400, `a non-string field is rejected (${r.status})`);

console.log('\n🔹 No invented district');
const { realDistrictOrNull, getUserAddresses } = await import('../src/services/addressService.js');
const { getStreetSuggestions } = await import('../src/services/autocompleteService.js');
assert(realDistrictOrNull('Център / Район') === null && realDistrictOrNull(' въведен адрес ') === null && realDistrictOrNull('') === null && realDistrictOrNull(null) === null, 'placeholder or empty districts are dropped');
assert(realDistrictOrNull('Център / Колю Фичето') === 'Център / Колю Фичето' && realDistrictOrNull('Бузлуджа') === 'Бузлуджа', 'a real district is kept');
const national = await getStreetSuggestions('Велико Търново', 'Дъб');
assert(national.length > 0 && national.every((s) => !/Център \/ Район|Въведен адрес/i.test(s.district || '')), 'suggestions never carry a made-up district');
const typed = await getStreetSuggestions('Велико Търново', 'Неизвестна 45');
assert(typed.length > 0 && typed.every((s) => !/Център \/ Район|Въведен адрес/i.test(s.district || '')), 'a typed address is not labelled "Въведен адрес"');
r = await call(saveAddressHandler, { body: { ...addr(guest), district: 'Център / Район' } });
assert(r.status === 201 && r.payload.data.district === null, 'saving an address does not store the placeholder district');
inMemoryDB.saved_addresses.push({ id: 'legacy-1', user_id: 'legacy-guest', label: 'Стар', city: 'София', street_name: 'ул. Дъб 45', district: 'Център / Район' });
const legacy = await getUserAddresses('legacy-guest');
inMemoryDB.saved_addresses = inMemoryDB.saved_addresses.filter((a) => a.user_id !== 'legacy-guest' && a.user_id !== guest);
assert(legacy.length === 1 && legacy[0].district === null, 'an address saved earlier with the placeholder is returned without it');

console.log('\n🔹 What the browser sends with a saved address, and with any query string');
{
  const { sanitizeClientCoordinates } = await import('../src/services/addressService.js');
  const ok = sanitizeClientCoordinates(42.7, 23.3);
  assert(ok && ok.lat === 42.7 && ok.lng === 23.3, 'a point in Bulgaria is kept');
  const okStr = sanitizeClientCoordinates('42.7', '23.3');
  assert(okStr && okStr.lat === 42.7 && okStr.lng === 23.3, 'coordinates sent as text are read as numbers');
  assert(sanitizeClientCoordinates(1e308, -1e308) === null, '1e308 is not a coordinate');
  assert(sanitizeClientCoordinates('abc', {}) === null && sanitizeClientCoordinates(NaN, 23) === null, 'text / NaN / an object are ignored');
  assert(sanitizeClientCoordinates(0, 0) === null && sanitizeClientCoordinates(91, 23) === null && sanitizeClientCoordinates(48.2, 16.4) === null, 'points outside Bulgaria (the sea off Africa, an impossible latitude, Vienna) are ignored');
  assert(sanitizeClientCoordinates('', '') === null && sanitizeClientCoordinates(undefined, undefined) === null && sanitizeClientCoordinates(42.7, null) === null, 'missing coordinates mean "geocode it"');
  assert(sanitizeClientCoordinates(41.9, 28.99) !== null && sanitizeClientCoordinates(44.3, 22.4) !== null, 'the edges of the country are inside');

  const guest2 = `guest-validation-${Date.now()}`;
  let rr = await call(saveAddressHandler, { body: { ...addr(guest2), region: { $ne: 1 } } });
  assert(rr.status === 400, 'a region that is not text is refused');
  rr = await call(saveAddressHandler, { body: { ...addr(guest2), district: 12345 } });
  assert(rr.status === 400, 'a district that is not text is refused');
  rr = await call(saveAddressHandler, { body: { ...addr(guest2), municipality: 'о'.repeat(201) } });
  assert(rr.status === 400, 'a municipality over 200 characters is refused');
  rr = await call(saveAddressHandler, { body: addr('u'.repeat(101)) });
  assert(rr.status === 400, 'an identifier over 100 characters is refused');
  rr = await call(saveAddressHandler, { body: { ...addr(guest2), region: null, municipality: null, district: null } });
  assert(rr.status === 201, 'null optional fields are fine');
  inMemoryDB.saved_addresses = inMemoryDB.saved_addresses.filter((a) => a.user_id !== guest2);

  const { normalizeQuery } = await import('../src/utils/queryNormalizer.js');
  const reqQ = { query: { q: ['a', 'b'], nested: { x: '1' }, plain: 'fine', objInArray: [{ a: 1 }], empty: [] } };
  let nextCalled = false;
  normalizeQuery(reqQ, {}, () => { nextCalled = true; });
  assert(nextCalled && reqQ.query.q === 'a' && reqQ.query.nested === '' && reqQ.query.plain === 'fine' && reqQ.query.objInArray === '' && reqQ.query.empty === '', 'a repeated or bracketed query parameter becomes a plain string (it used to make six routes answer 500)');
  const reqNo = {};
  normalizeQuery(reqNo, {}, () => {});
  assert(true, 'a request without a query never throws');
}

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
