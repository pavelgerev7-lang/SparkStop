import { checkAddressOutageStatus, getLiveMapOutages, upsertOutage, getOutagesTablePage } from '../services/outageService.js';
import { runScraperJob } from '../services/scraperService.js';

/**
 * GET /api/outages/check?street=...&city=...
 * Returns traffic light status (green / yellow / red) + countdown timer to expected_end_time.
 */
export async function checkOutageHandler(req, res, next) {
  try {
    const { street, city } = req.query;

    if (!street || typeof street !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Моля, посочете дума за търсене на улица през параметъра "?street=..."'
      });
    }
    if (street.length > 200 || (city && typeof city === 'string' && city.length > 200)) {
      return res.status(400).json({ success: false, error: 'Твърде дълга стойност за street/city.' });
    }

    const targetCity = city || 'София';
    const result = await checkAddressOutageStatus(street, targetCity);

    return res.json({
      success: true,
      data: result
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/outages/live-map
 * Returns list of all active/scheduled outages with coordinates for dark mode map.
 */
export async function liveMapHandler(req, res, next) {
  try {
    const { city, utility } = req.query;
    const mapItems = await getLiveMapOutages(city, utility);

    return res.json({
      success: true,
      count: mapItems.length,
      data: mapItems
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/outages-table
 * Paginated, filterable/searchable outages browser for the admin panel.
 */
export async function outagesTableHandler(req, res, next) {
  try {
    const { utility, status, search, limit, offset } = req.query;
    const safeSearch = typeof search === 'string' ? search.slice(0, 200) : null;
    const page = await getOutagesTablePage({
      utility: utility || null,
      status: status || null,
      search: safeSearch,
      limit: Math.min(100, Math.max(1, parseInt(limit, 10) || 25)),
      offset: Math.max(0, parseInt(offset, 10) || 0)
    });
    return res.json({ success: true, data: page });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/outages/trigger-scraper
 * Manual endpoint to trigger web scraper and AI parser on demand.
 *
 * Fire-and-forget, matching the same pattern already used for
 * url-health/run and source-audit/run — a full cycle now checks 65+
 * providers, each with its own network fetch and AI-parse-with-retries, so
 * awaiting the whole thing here risked the same request-timeout problem
 * those two already hit and were fixed for. The frontend button this backs
 * was actually never wired to anything in the UI at all (confirmed by
 * grep — triggerScraperModal() existed with zero callers), found and fixed
 * in the same pass as this change, and polls GET /api/admin/stats for
 * scraper.last_run_at to change instead of waiting on this response.
 */
export function triggerScraperHandler(req, res) {
  runScraperJob().catch((err) => console.error('❌ [MANUAL SCRAPER TRIGGER ERROR]', err.message));
  res.status(202).json({ success: true, message: 'Сканирането стартира във фонов режим — може да отнеме няколко минути за всички доставчици.' });
}

/**
 * POST /api/outages/manual-add
 * Manual endpoint to submit raw Bulgarian text or structured outage object
 */
export async function manualAddOutageHandler(req, res, next) {
  try {
    const outageData = req.body;
    const result = await upsertOutage(outageData);
    return res.status(201).json({
      success: true,
      message: 'Аварията е регистрирана успешно!',
      data: result
    });
  } catch (err) {
    next(err);
  }
}
