import { saveUserAddress, getUserAddresses, setAddressNotificationPreference } from '../services/addressService.js';
import { getStreetSuggestions } from '../services/autocompleteService.js';
import { BULGARIAN_SETTLEMENTS, searchSettlements } from '../utils/bulgarianSettlements.js';
import { verifyAuthToken, isRegisteredUserId } from '../services/authService.js';
import { verifyHouseNumberPlausible } from '../services/geocodingService.js';

/**
 * A request that changes the addresses of a REGISTERED account must carry that account's own session token. A
 * guest/device id (generated in the browser, nothing server-side behind it) cannot have one — that is inherent to
 * guest mode. Without this check anyone who learned an account's id could fill its 3 address slots, delete its
 * addresses, or subscribe their own device to its notifications. Sends the 403 itself; returns whether to go on.
 */
async function sessionMayChangeAddressesOf(req, res, userId) {
  if (!(await isRegisteredUserId(userId))) return true;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = verifyAuthToken(token);
  if (session && session.userId === userId) return true;
  res.status(403).json({ success: false, message: 'Достъпът е отказан.' });
  return false;
}

/**
 * POST /api/addresses/save
 * Validates and saves a new address, enforcing max 3 addresses limit per user.
 */
export async function saveAddressHandler(req, res, next) {
  try {
    const { user_id, userId, label, city, street_name, streetName, district, municipality, region, lat, lng } = req.body;

    const targetUserId = user_id || userId;
    const targetStreetName = street_name || streetName;

    if (!targetUserId || !label || !city || !targetStreetName) {
      return res.status(400).json({
        success: false,
        error: 'Невалидни данни. Задължителни са: userId, label, city и streetName.'
      });
    }
    if (typeof targetUserId !== 'string' || targetUserId.length > 100 || [label, city, targetStreetName].some((v) => typeof v !== 'string' || v.length > 200)) {
      return res.status(400).json({ success: false, error: 'Невалидни данни.' });
    }
    // The optional text fields end up in the database as they are: text only, and not unbounded.
    if ([district, municipality, region].some((v) => v !== undefined && v !== null && (typeof v !== 'string' || v.length > 200))) {
      return res.status(400).json({ success: false, error: 'Невалидни данни.' });
    }
    if (!(await sessionMayChangeAddressesOf(req, res, targetUserId))) return;

    const savedRecord = await saveUserAddress({
      user_id: targetUserId,
      label,
      city,
      municipality,
      region,
      street_name: targetStreetName,
      district,
      lat,
      lng
    });

    return res.status(201).json({
      success: true,
      message: 'Адресът е запазен успешно!',
      data: savedRecord
    });
  } catch (err) {
    if (err.code === 'ADDR_LIMIT_EXCEEDED' || err.statusCode === 400) {
      return res.status(400).json({
        success: false,
        error: err.message || 'Достигнахте максималния лимит от 3 запазени адреса за този профил.'
      });
    }
    next(err);
  }
}

/**
 * GET /api/addresses/verify-number?city=...&street=...&number=...
 * Soft, non-blocking plausibility check for a house number on a street —
 * used by the Add Address modal to warn (not block) on a likely typo before
 * saving. See verifyHouseNumberPlausible() for why this can't be a strict
 * "does this exact number exist" check.
 */
export async function verifyHouseNumberHandler(req, res, next) {
  try {
    const { city, street, number, municipality, region } = req.query;
    if (!city || !street || !number) {
      return res.json({ success: true, data: { checked: false } });
    }
    const result = await verifyHouseNumberPlausible(city, street, number, municipality, region);
    return res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/addresses/user/:userId
 * Returns saved addresses for given user ID
 */
export async function getUserAddressesHandler(req, res, next) {
  try {
    const { userId } = req.params;

    // A guest/device id (generated client-side, no server-issued credential
    // behind it at all) has nothing to check a token against — that's
    // inherent to how guest mode works, not a gap this can close. For an id
    // that actually belongs to a registered account though, requiring the
    // caller to hold a session token for THAT exact account closes a real
    // hole: anyone who learned another user's id (a screenshot, a log line)
    // could otherwise read their full saved-address list with no credential
    // at all, just by knowing the id. Checked against the real users
    // store/table rather than guessing from the id's shape — in-memory ids
    // happen to be prefixed "user-", but a real Postgres UUID never is.
    if (await isRegisteredUserId(userId)) {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const session = verifyAuthToken(token);
      if (!session || session.userId !== userId) {
        return res.status(403).json({ success: false, message: 'Достъпът е отказан.' });
      }
    }

    const addresses = await getUserAddresses(userId);
    return res.json({
      success: true,
      count: addresses.length,
      limit: 3,
      data: addresses
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/settlements/autocomplete?q=...
 * Live autocomplete suggestions for Bulgarian cities, towns and villages with municipality and province
 */
export async function autocompleteSettlementHandler(req, res, next) {
  try {
    const { q, province, municipality } = req.query;
    const suggestions = searchSettlements(q || '', 25, province || '', municipality || '');
    return res.json({
      success: true,
      query: q || '',
      count: suggestions.length,
      data: suggestions
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/cities
 * Returns list of all Bulgarian cities and settlements with municipality and region
 */
export async function getCitiesHandler(req, res, next) {
  try {
    return res.json({
      success: true,
      count: BULGARIAN_SETTLEMENTS.length,
      data: BULGARIAN_SETTLEMENTS
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/geo/provinces
 * Returns list of all 28 Bulgarian provinces (Области)
 */
export async function getProvincesHandler(req, res, next) {
  try {
    const { BULGARIAN_PROVINCES, searchProvinces } = await import('../utils/bulgarianSettlements.js');
    const q = req.query.q;
    const provinces = q ? searchProvinces(q) : BULGARIAN_PROVINCES;
    return res.json({
      success: true,
      data: provinces
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/geo/provinces/autocomplete?q=...
 */
export async function autocompleteProvincesHandler(req, res, next) {
  try {
    const { q } = req.query;
    const { searchProvinces } = await import('../utils/bulgarianSettlements.js');
    const results = searchProvinces(q || '', 10);
    return res.json({
      success: true,
      data: results
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/geo/municipalities?province=...
 * Returns list of municipalities (Общини) for a given province
 */
export async function getMunicipalitiesHandler(req, res, next) {
  try {
    const { province, q } = req.query;
    const { searchMunicipalities, getMunicipalitiesByProvince } = await import('../utils/bulgarianSettlements.js');
    if (q) {
      const results = searchMunicipalities(q, province || '', 15);
      return res.json({
        success: true,
        data: results
      });
    }
    const municipalities = getMunicipalitiesByProvince(province || 'София-град');
    return res.json({
      success: true,
      province: province || 'София-град',
      data: municipalities
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/geo/municipalities/autocomplete?q=...&province=...
 */
export async function autocompleteMunicipalitiesHandler(req, res, next) {
  try {
    const { q, province } = req.query;
    const { searchMunicipalities } = await import('../utils/bulgarianSettlements.js');
    const results = searchMunicipalities(q || '', province || '', 15);
    return res.json({
      success: true,
      data: results
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/geo/settlements?province=...&municipality=...&q=...
 * Returns settlements filtered by province, municipality, and optional search query
 */
export async function getSettlementsHandler(req, res, next) {
  try {
    const { province, municipality, q } = req.query;
    const { getSettlementsByAdmin, searchSettlements } = await import('../utils/bulgarianSettlements.js');
    
    let settlements = [];
    if (province || municipality) {
      settlements = getSettlementsByAdmin(province || '', municipality || '', q || '');
    } else {
      settlements = searchSettlements(q || '', 30);
    }

    return res.json({
      success: true,
      count: settlements.length,
      data: settlements
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/addresses/autocomplete?city=...&q=...
 * Live autocomplete suggestions for streets and districts in Bulgarian cities
 */
export async function autocompleteAddressHandler(req, res, next) {
  try {
    const { city, q } = req.query;
    const suggestions = await getStreetSuggestions(city || 'София', q || '');
    return res.json({
      success: true,
      city: city || 'София',
      query: q || '',
      count: suggestions.length,
      data: suggestions
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/addresses/:id?userId=...
 */
export async function deleteAddressHandler(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.query.userId || req.body?.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Липсва потребителски идентификатор.' });
    }
    if (!(await sessionMayChangeAddressesOf(req, res, String(userId)))) return;
    const { deleteUserAddress } = await import('../services/addressService.js');
    const deleted = await deleteUserAddress(id, userId);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Адресът не е намерен или не принадлежи на този потребител.' });
    }
    return res.json({
      success: true,
      message: 'Адресът беше изтрит успешно.',
      deleted
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/addresses/:id/notifications
 * Body: { userId, enabled, fcm_token? }
 */
export async function updateAddressNotificationHandler(req, res, next) {
  try {
    const { id } = req.params;
    const { userId, enabled, fcm_token } = req.body;
    if (userId && !(await sessionMayChangeAddressesOf(req, res, String(userId)))) return;
    const result = await setAddressNotificationPreference(id, userId, !!enabled, fcm_token || null);
    return res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
