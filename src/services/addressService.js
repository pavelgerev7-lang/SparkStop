import { query, inMemoryDB, persistLocalDB } from '../config/db.js';
import { geocodeStreetWithNominatim } from './geocodingService.js';
import crypto from 'crypto';

// Serializes saveUserAddress calls per user_id so the count-check and the
// insert (separated by awaited DB/geocoding calls below) can't interleave
// across two concurrent requests for the same user (e.g. phone + laptop both
// saving within the same request window) and both slip past the 3-address
// limit. Keyed per-process, which is enough here since this is a single
// Node server, not a horizontally-scaled deployment.
const userSaveQueues = new Map();
function runExclusive(key, fn) {
  const prev = userSaveQueues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  userSaveQueues.set(key, run.catch(() => {}));
  return run;
}

// Earlier versions of the street suggestions filled these in as if they were a real district, and
// clients that still hold them would save them — an address is never stored with such a "district".
const PLACEHOLDER_DISTRICTS = new Set(['център / район', 'въведен адрес']);
export function realDistrictOrNull(district) {
  const text = String(district ?? '').trim();
  return text && !PLACEHOLDER_DISTRICTS.has(text.toLowerCase()) ? text : null;
}

/**
 * Saves a new address for a user enforcing the strict limit of maximum 3 addresses.
 *
 * @param {Object} addressData - { user_id, label, city, street_name, district, municipality, region, lat, lng }
 * @returns {Promise<Object>} The newly created saved address
 */
// The browser sends the coordinates of the suggestion the person picked. Anything that is not a point in Bulgaria
// (text, NaN, 1e308, a point in the sea or on another continent) is ignored and the address is geocoded instead:
// a stored absurd point breaks distance maths and draws the saved-address pin nowhere.
const BG_LAT = [41.0, 44.5];
const BG_LNG = [22.0, 29.0];
export function sanitizeClientCoordinates(lat, lng) {
  if (lat === undefined || lat === null || lat === '' || lng === undefined || lng === null || lng === '') return null;
  const la = typeof lat === 'number' ? lat : parseFloat(lat);
  const lo = typeof lng === 'number' ? lng : parseFloat(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (la < BG_LAT[0] || la > BG_LAT[1] || lo < BG_LNG[0] || lo > BG_LNG[1]) return null;
  return { lat: la, lng: lo };
}

export async function saveUserAddress(addressData) {
  const { user_id, label, city, street_name, district, municipality, region, lat, lng } = addressData;

  if (!user_id || !label || !city || !street_name) {
    const error = new Error('Задължителните полета са: user_id, label, city и street_name.');
    error.statusCode = 400;
    throw error;
  }

  return runExclusive(user_id, () => saveUserAddressExclusive(addressData));
}

async function saveUserAddressExclusive(addressData) {
  const { user_id, label, city, street_name, district, municipality, region, lat, lng } = addressData;

  // 1. Check existing count of saved addresses for this user_id
  const countResult = await query(
    `SELECT COUNT(*) FROM saved_addresses WHERE user_id = $1`,
    [user_id]
  );

  let currentCount = 0;
  if (countResult && countResult.rows) {
    currentCount = parseInt(countResult.rows[0].count, 10);
  } else {
    // In-memory DB fallback count
    currentCount = inMemoryDB.saved_addresses.filter((a) => a.user_id === user_id).length;
  }

  if (currentCount >= 3) {
    const error = new Error('Достигнахте максималния лимит от 3 запазени адреса за този профил.');
    error.statusCode = 400;
    error.code = 'ADDR_LIMIT_EXCEEDED';
    throw error;
  }

  const clientPoint = sanitizeClientCoordinates(lat, lng);
  let finalLat = clientPoint ? clientPoint.lat : null;
  let finalLng = clientPoint ? clientPoint.lng : null;

  if (finalLat === null || finalLng === null) {
    // Precise (Nominatim-backed, cached) lookup — a saved address is a long-lived
    // pin a user will check repeatedly, so it's worth the one-time real geocode
    // instead of settling for the city-center fallback.
    const geo = await geocodeStreetWithNominatim(city, street_name, municipality, region);
    finalLat = geo.lat;
    finalLng = geo.lng;
  }

  const dbInsert = await query(
    `INSERT INTO saved_addresses (user_id, label, city, municipality, region, street_name, district, lat, lng)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [user_id, label, city, municipality || null, region || null, street_name, realDistrictOrNull(district), finalLat, finalLng]
  );
  if (dbInsert && dbInsert.rows && dbInsert.rows[0]) {
    return dbInsert.rows[0];
  }

  // In-memory / JSON DB insertion
  const newAddress = {
    id: `addr-${crypto.randomUUID()}`,
    user_id,
    label,
    city,
    municipality: municipality || null,
    region: region || null,
    street_name,
    district: realDistrictOrNull(district),
    lat: finalLat,
    lng: finalLng,
    notifications_enabled: false,
    fcm_token: null,
    created_at: new Date().toISOString()
  };

  inMemoryDB.saved_addresses.push(newAddress);
  persistLocalDB();
  return newAddress;
}

/**
 * Retrieves all saved addresses for a specific user ID
 * @param {string} userId 
 */
export async function getUserAddresses(userId) {
  if (!userId) return [];

  const dbResult = await query(
    `SELECT id, user_id, label, city, street_name, district, lat, lng, notifications_enabled, created_at
     FROM saved_addresses
     WHERE user_id = $1
     ORDER BY created_at ASC`,
    [userId]
  );

  const rows = (dbResult && dbResult.rows) ? dbResult.rows : inMemoryDB.saved_addresses.filter((a) => a.user_id === userId);
  // Addresses saved before the placeholder was removed still carry it in the database.
  return rows.map((a) => (a.district && !realDistrictOrNull(a.district) ? { ...a, district: null } : a));
}

/**
 * Deletes a saved address by ID
 * @param {string} addressId 
 * @param {string} userId 
 */
export async function deleteUserAddress(addressId, userId) {
  if (!addressId || !userId) return false;

  const dbResult = await query(
    `DELETE FROM saved_addresses WHERE id = $1 AND user_id = $2`,
    [addressId, userId]
  );

  const beforeCount = inMemoryDB.saved_addresses.length;
  inMemoryDB.saved_addresses = inMemoryDB.saved_addresses.filter(
    (a) => !(a.id === addressId && a.user_id === userId)
  );
  const removedFromMemory = inMemoryDB.saved_addresses.length < beforeCount;

  persistLocalDB();

  const removedFromDb = dbResult && typeof dbResult.rowCount === 'number' ? dbResult.rowCount > 0 : false;
  return removedFromDb || removedFromMemory;
}

/**
 * Enables or disables push notifications for one specific saved address (the
 * "bell" toggle on its card) — notifications are opted into per-address, not
 * globally per account, so a user with 3 addresses can choose to be notified
 * about only some of them.
 *
 * @param {string} addressId
 * @param {string} userId - must own the address (same ownership check as delete)
 * @param {boolean} enabled
 * @param {string|null} fcmToken - required when enabling; ignored when disabling
 */
export async function setAddressNotificationPreference(addressId, userId, enabled, fcmToken) {
  if (!addressId || !userId) {
    const error = new Error('Липсва адрес или потребител.');
    error.statusCode = 400;
    throw error;
  }
  if (enabled && !fcmToken) {
    const error = new Error('Липсва token за известия.');
    error.statusCode = 400;
    throw error;
  }

  const tokenToStore = enabled ? fcmToken : null;

  const dbResult = await query(
    `UPDATE saved_addresses SET notifications_enabled = $1, fcm_token = $2 WHERE id = $3 AND user_id = $4 RETURNING id`,
    [enabled, tokenToStore, addressId, userId]
  );

  const memAddr = inMemoryDB.saved_addresses.find((a) => a.id === addressId && a.user_id === userId);
  if (memAddr) {
    memAddr.notifications_enabled = enabled;
    memAddr.fcm_token = tokenToStore;
    persistLocalDB();
  }

  const updatedInDb = dbResult && typeof dbResult.rowCount === 'number' ? dbResult.rowCount > 0 : false;
  if (!updatedInDb && !memAddr) {
    const error = new Error('Адресът не е намерен или не принадлежи на този потребител.');
    error.statusCode = 404;
    throw error;
  }

  return { id: addressId, notifications_enabled: enabled };
}

/**
 * Clears a dead FCM token everywhere it's stored, not just on one address.
 * The same device token gets saved onto every address a user enables
 * notifications for from that device/browser, so when FCM reports a token
 * as no-longer-registered (uninstalled, cleared site data, blocked
 * notifications), disabling only the one address that happened to trigger
 * that particular send left every OTHER address sharing the same dead
 * token stuck silently retrying — and failing — forever, with the bell
 * still showing "on" and no way for the user to notice.
 */
export async function clearDeadFcmToken(token) {
  if (!token) return { cleared: 0 };

  const dbResult = await query(
    `UPDATE saved_addresses SET notifications_enabled = false, fcm_token = NULL WHERE fcm_token = $1 RETURNING id`,
    [token]
  );

  let clearedInMemory = 0;
  for (const addr of inMemoryDB.saved_addresses) {
    if (addr.fcm_token === token) {
      addr.notifications_enabled = false;
      addr.fcm_token = null;
      clearedInMemory++;
    }
  }
  if (clearedInMemory > 0) persistLocalDB();

  const clearedInDb = dbResult && typeof dbResult.rowCount === 'number' ? dbResult.rowCount : 0;
  return { cleared: clearedInDb + clearedInMemory };
}

