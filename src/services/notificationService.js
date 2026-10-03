import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import dotenv from 'dotenv';
import { query, inMemoryDB, persistLocalDB } from '../config/db.js';
import { isAddressAffected } from '../utils/streetNormalizer.js';
import { clearDeadFcmToken } from './addressService.js';
import crypto from 'crypto';

const UTILITY_SHORT_LABELS = {
  water: 'Проблем с водоснабдяването',
  electricity: 'Прекъсване на тока',
  heating: 'Проблем с парното',
  gas: 'Проблем с газоснабдяването'
};

/**
 * Records that an outage was matched to a user's address and (attempted to
 * be) pushed to them — independent of whether the FCM send itself actually
 * succeeded, since what matters for "did I miss anything?" history is that
 * the outage WAS relevant to that address. Lets someone who was away from
 * their phone/computer when the push fired check back later.
 */
function logNotificationHistory({ userId, addressId, addressLabel, city, street, utilityType, outageId, message }) {
  const entry = {
    id: `notiflog-${crypto.randomUUID()}`,
    user_id: userId,
    address_id: addressId,
    address_label: addressLabel,
    city,
    street,
    utility_type: utilityType,
    message: message || UTILITY_SHORT_LABELS[utilityType] || 'Регистрирана авария',
    outage_id: outageId,
    sent_at: new Date().toISOString()
  };
  inMemoryDB.notification_log.push(entry);
  persistLocalDB();
  // The hosted server's disk is wiped on every deploy/restart, so a history kept only in memory + a local file
  // was empty again after each one: it lives in Postgres too (table created at start-up, see config/db.js).
  query(
    `INSERT INTO notification_log (id, user_id, address_id, address_label, city, street, utility_type, message, outage_id, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
    [entry.id, entry.user_id, String(entry.address_id ?? ''), entry.address_label, entry.city, entry.street, entry.utility_type, entry.message, String(entry.outage_id ?? ''), entry.sent_at]
  ).catch((e) => console.warn('notification_log insert failed:', e.message));
  return entry;
}

export async function getNotificationHistoryForUser(userId) {
  if (!userId) return [];
  const db = await query(
    `SELECT id, user_id, address_id, address_label, city, street, utility_type, message, outage_id, sent_at
     FROM notification_log WHERE user_id = $1 ORDER BY sent_at DESC LIMIT 100`,
    [userId]
  ).catch(() => null);
  if (db && db.rows) return db.rows.map((r) => ({ ...r, sent_at: new Date(r.sent_at).toISOString() }));
  return inMemoryDB.notification_log
    .filter((n) => n.user_id === userId)
    .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
}

dotenv.config();

let firebaseInitialized = false;

// Initialize Firebase Admin SDK if credentials provided
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT.startsWith('{')) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
      serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
    }

    initializeApp({
      credential: cert(serviceAccount)
    });
    firebaseInitialized = true;
    console.log('✅ Firebase Cloud Messaging (FCM) initialized successfully.');
  } catch (err) {
    console.warn('⚠️ Could not initialize Firebase Admin SDK. Fallback to simulated push notifications:', err.message);
  }
} else {
  console.log('ℹ️ FIREBASE_SERVICE_ACCOUNT not set. Push notifications running in simulated console log mode.');
}

// Lets the admin panel show at a glance whether real push notifications are
// live in this environment, or still just logged to the console — the most
// common way this differs between local dev and Render is simply whether
// the FIREBASE_SERVICE_ACCOUNT env var was actually set there.
export function isFirebaseInitialized() {
  return firebaseInitialized;
}

/**
 * Sends one real push directly to a specific saved address's stored
 * fcm_token, bypassing outage-matching entirely — a diagnostic tool so a
 * failed delivery ("I enabled it but nothing arrived") can be root-caused
 * from the actual Firebase error instead of guessing from a phone's OS
 * settings. Returns the raw outcome (including Firebase's own error code)
 * instead of swallowing it like the normal notify path does.
 */
export async function sendTestNotification(addressId) {
  let addr = null;
  const dbResult = await query(
    `SELECT id, user_id, label, city, street_name, notifications_enabled, fcm_token FROM saved_addresses WHERE id = $1`,
    [addressId]
  );
  if (dbResult && dbResult.rows && dbResult.rows[0]) {
    addr = dbResult.rows[0];
  } else {
    addr = inMemoryDB.saved_addresses.find((a) => a.id === addressId);
  }

  if (!addr) {
    return { ok: false, reason: 'address_not_found' };
  }
  if (!addr.notifications_enabled || !addr.fcm_token) {
    return { ok: false, reason: 'notifications_not_enabled_for_this_address', address: { id: addr.id, label: addr.label } };
  }
  if (!firebaseInitialized) {
    return { ok: false, reason: 'firebase_not_initialized' };
  }

  // Data-only, same reasoning as the real notify path — see comment there.
  // webpush.headers.Urgency: data-only messages default to normal priority,
  // which Android can silently defer or drop under battery optimization /
  // Doze for a backgrounded browser — force high priority so it's not queued
  // behind power-saving throttling.
  const payload = {
    data: {
      title: '🔔 Тестово известие от СпаркСтоп',
      body: 'Ако виждаш това, известията работят правилно на това устройство.',
      test: 'true',
      url: '/'
    },
    webpush: {
      headers: { Urgency: 'high' }
    },
    token: addr.fcm_token
  };

  try {
    const messageId = await getMessaging().send(payload);
    return { ok: true, messageId, address: { id: addr.id, label: addr.label, city: addr.city, street: addr.street_name } };
  } catch (err) {
    return {
      ok: false,
      reason: 'fcm_send_failed',
      errorCode: err.code || null,
      errorMessage: err.message,
      address: { id: addr.id, label: addr.label, city: addr.city, street: addr.street_name }
    };
  }
}

/**
 * Sends one prepared push to one device and retries transient failures.
 * Returns { ok, permanent }: `permanent` is true when the token itself is dead (retrying can never help).
 */
async function deliverPush(item, payload) {
  const { title, body } = payload.data;

  if (!firebaseInitialized) {
    // Simulated Push Notification Mode
    console.log(`🔔 [SIMULATED PUSH NOTIFICATION SENT]
   To FCM Token: ${item.token}
   User ID: ${item.userId}
   Title: "${title}"
   Body: "${body}"
   Data Payload: ${JSON.stringify(payload.data)}`);
    return { ok: true, permanent: false };
  }

  // A token being permanently dead is the ONE case retrying can never
  // fix — every other failure (a network blip reaching Google, FCM's
  // own transient internal-error/server-unavailable responses, a brief
  // rate-limit) is exactly the kind of one-off hiccup a short retry
  // clears up. Before this, ANY failure on the single attempt — even a
  // one-second network blip — silently dropped that notification with
  // no second try, for an event the user explicitly asked to be
  // notified about at their saved address.
  const PERMANENT_FAILURE_CODES = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument',
    'messaging/mismatched-credential'
  ]);
  const RETRY_DELAYS_MS = [800, 2000];

  let sent = false;
  let lastErr = null;
  for (let attempt = 0; !sent; attempt++) {
    try {
      await getMessaging().send(payload);
      console.log(`🚀 FCM Push notification sent for address ${item.addressId} (token: ${item.token.substring(0, 15)}...)${attempt > 0 ? ` after ${attempt} retry(ies)` : ''}`);
      sent = true;
    } catch (err) {
      lastErr = err;
      if (PERMANENT_FAILURE_CODES.has(err.code) || attempt >= RETRY_DELAYS_MS.length) {
        break;
      }
      console.warn(`⚠️ FCM send attempt ${attempt + 1} failed for address ${item.addressId} (${err.message}) — retrying...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }

  if (!sent && lastErr) {
    console.error(`❌ Failed to send FCM notification for address ${item.addressId} after retries:`, lastErr.message);
    // A token stops being valid if the user cleared site data, uninstalled
    // the PWA, blocked notifications, etc. — the SAME token is stored on
    // every address that user enabled notifications for from that
    // device, so clear it everywhere it appears (not just this one
    // address) instead of retrying it forever on every future outage.
    if (lastErr.code === 'messaging/registration-token-not-registered' || lastErr.code === 'messaging/invalid-registration-token') {
      try {
        await clearDeadFcmToken(item.token);
      } catch (cleanupErr) {
        console.warn('Could not clear stale FCM token:', cleanupErr.message);
      }
    }
  }
  return { ok: sent, permanent: !sent && !!lastErr && PERMANENT_FAILURE_CODES.has(lastErr.code) };
}

// Reminders already pushed, so the every-5-minutes job never sends the same one twice (and two server
// instances overlapping during a deploy cannot both send it). Postgres table `outage_reminders`;
// an in-memory set stands in when there is no database.
const memoryReminderKeys = new Set();

function reminderKey(kind, outage, token) {
  const who = crypto.createHash('sha1').update(String(token)).digest('hex').slice(0, 16);
  return [kind, outage.provider || '', outage.utility_type || '', new Date(outage.start_time).toISOString(), who].join('|');
}

/** True for the caller that claims this reminder (and so must send it). */
async function claimReminder(key, kind, outageId) {
  const res = await query(
    `INSERT INTO outage_reminders (dedupe_key, kind, outage_id) VALUES ($1, $2, $3)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key`,
    [key, kind, String(outageId ?? '')]
  );
  if (res && res.rows) return res.rows.length === 1;
  if (memoryReminderKeys.has(key)) return false;
  memoryReminderKeys.add(key);
  return true;
}

async function releaseReminder(key) {
  memoryReminderKeys.delete(key);
  await query('DELETE FROM outage_reminders WHERE dedupe_key = $1', [key]).catch(() => {});
}

/**
 * Pushes one reminder ("day_before", "hour_before", "ended") about `outage` to every device with an address it
 * affects, at most once per device. `buildMessage(item)` returns { title, body } for that address.
 * A transient FCM failure releases the claim so the next run tries again; a dead token does not.
 */
export async function sendOutageReminder(outage, kind, buildMessage) {
  const matches = await findAffectedAddressesForOutage(outage);
  let sent = 0;
  for (const item of matches) {
    const key = reminderKey(kind, outage, item.token);
    if (!(await claimReminder(key, kind, outage.id))) continue;

    const { title, body } = buildMessage(item);
    const payload = {
      data: {
        title,
        body,
        kind,
        outage_id: String(outage.id),
        street: String(item.street),
        utility_type: String(outage.utility_type || 'water'),
        provider: String(outage.provider || ''),
        url: '/'
      },
      webpush: { headers: { Urgency: 'high' } },
      token: item.token
    };
    const delivery = await deliverPush(item, payload);
    if (delivery.ok) {
      sent++;
      // The history ("Съобщения") shows what the phone showed.
      logNotificationHistory({
        userId: item.userId,
        addressId: item.addressId,
        addressLabel: item.label,
        city: item.city,
        street: item.street,
        utilityType: outage.utility_type || 'water',
        outageId: outage.id,
        message: title
      });
    } else if (!delivery.permanent) {
      await releaseReminder(key);
    }
  }
  return { matched: matches.length, sent };
}

/**
 * The saved addresses (one per device) that opted into notifications and that `outage` affects.
 * @param {Object} outage - Outage object ({ id, city, affected_streets, raw_location_text })
 */
export async function findAffectedAddressesForOutage(outage) {
  const affectedCity = outage.city.trim();
  const outageStreets = outage.affected_streets;

  // 1. Fetch saved addresses in this city that opted into notifications, from
  // DB or inMemoryDB. Notifications are opted into per saved address (not
  // per account) — this also means it works the same for a logged-in user
  // and a device-only guest, since it never needs the users table at all.
  // A bulletin often covers several villages but is stored under ONE city (ЕРП
  // Север: the first village; EVN: the province name), so an address in any other
  // named village must be a candidate too — isAddressAffected() below still
  // decides per address, exactly as before.
  const namedSettlements = outageStreets
    .filter((s) => /^(?:с\.|село|гр\.|град)\s+/i.test(String(s || '')))
    .map((s) => String(s).replace(/^(?:с\.|село|гр\.|град)\s+/i, '').trim().toLowerCase())
    .filter(Boolean);
  const candidateCities = [...new Set([affectedCity.toLowerCase(), ...namedSettlements])];

  let candidateAddresses = [];
  const dbResult = await query(
    `SELECT id, user_id, label, city, street_name, fcm_token
     FROM saved_addresses
     WHERE LOWER(city) = ANY($1) AND notifications_enabled = true AND fcm_token IS NOT NULL`,
    [candidateCities]
  );

  if (dbResult && dbResult.rows) {
    candidateAddresses = dbResult.rows;
  } else {
    // In-memory DB fallback
    candidateAddresses = inMemoryDB.saved_addresses.filter(
      (sa) => candidateCities.includes(sa.city.toLowerCase()) && sa.notifications_enabled && sa.fcm_token
    );
  }

  // 2. Filter addresses matching outage affected streets
  const matchingNotifications = [];
  const processedUserTokens = new Set(); // Prevent duplicate push notifications to same user token

  for (const addr of candidateAddresses) {
    if (isAddressAffected(addr.street_name, outageStreets, outage.raw_location_text)) {
      if (!processedUserTokens.has(addr.fcm_token)) {
        processedUserTokens.add(addr.fcm_token);
        matchingNotifications.push({
          addressId: addr.id,
          userId: addr.user_id,
          token: addr.fcm_token,
          label: addr.label,
          city: addr.city,
          street: addr.street_name
        });
      }
    }
  }

  return matchingNotifications;
}

/**
 * Checks all saved user addresses matching the outage city and affected streets,
 * and sends Firebase Cloud Messaging (FCM) Push Notifications.
 *
 * @param {Object} outage - Outage object ({ id, city, affected_streets, utility_type, provider })
 * @returns {Promise<Object>} Summary of notification dispatch results
 */
export async function notifyAffectedUsersForOutage(outage) {
  if (!outage || !outage.city || !Array.isArray(outage.affected_streets)) {
    return { notifiedCount: 0, recipientTokens: [], simulated: true };
  }

  const matchingNotifications = await findAffectedAddressesForOutage(outage);
  if (matchingNotifications.length === 0) {
    console.log(`ℹ️ No matching user addresses found for outage in ${outage.city.trim()} on ${outage.affected_streets.join(', ')}`);
    return { notifiedCount: 0, recipientTokens: [], simulated: !firebaseInitialized };
  }

  // 3. Construct Notification Payload as required:
  // Title: "⚠️ Има бъдеща авария на вашия запазен адрес"
  // Body: "Влезте в приложението за повече информация."
  // Deliberately doesn't say WHAT's affected or WHEN — the point is to make
  // opening the app the only way to find out, driving app opens/engagement.
  // Data: { "outage_id": "...", "street": "..." }
  const title = "⚠️ Има бъдеща авария на вашия запазен адрес";
  const body = "Влезте в приложението за повече информация.";

  const dispatchedTokens = [];

  for (const item of matchingNotifications) {
    // Data-only payload (no top-level "notification" key) — when that key is
    // present, Firebase's SDK intercepts and auto-displays the push itself,
    // skipping our own onBackgroundMessage handler in sw.js entirely. That
    // auto-display path turned out to be unreliable (message accepted by
    // Firebase, nothing shown on the phone), so send everything as data and
    // let sw.js's own showNotification() call be the one definitive path.
    const payload = {
      data: {
        title,
        body,
        outage_id: String(outage.id),
        street: String(item.street),
        utility_type: String(outage.utility_type || 'water'),
        provider: String(outage.provider || ''),
        url: '/'
      },
      webpush: {
        headers: { Urgency: 'high' }
      },
      token: item.token
    };

    logNotificationHistory({
      userId: item.userId,
      addressId: item.addressId,
      addressLabel: item.label,
      city: item.city,
      street: item.street,
      utilityType: outage.utility_type || 'water',
      outageId: outage.id
    });

    const delivery = await deliverPush(item, payload);
    if (delivery.ok) dispatchedTokens.push(item.token);
  }

  return {
    notifiedCount: dispatchedTokens.length,
    recipientTokens: dispatchedTokens,
    simulated: !firebaseInitialized
  };
}
