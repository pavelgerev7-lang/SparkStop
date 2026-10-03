import { inMemoryDB, getDbStatus, query } from '../config/db.js';
import { getScraperStatus } from '../services/scraperService.js';
import { isFirebaseInitialized } from '../services/notificationService.js';
import { getLastIntegritySweepResult, getLastPruneResult } from '../services/outageService.js';
import { getActiveVisitorCount } from '../services/activityTrackerService.js';

/**
 * GET /api/admin/stats
 * Read-only overview: outage counts, users, saved addresses, DB mode, last
 * scrape, whether push notifications are actually live. Gated by
 * requireAdmin in server.js (owner-only).
 */
export async function getStatsHandler(req, res, next) {
  try {
    const dbStatus = getDbStatus();
    const outagesResult = await query('SELECT utility_type, status FROM outages', []);
    const outages = (outagesResult && outagesResult.rows) || inMemoryDB.outages;

    const byUtility = {};
    let activeCount = 0;
    let scheduledCount = 0;
    for (const o of outages) {
      byUtility[o.utility_type] = (byUtility[o.utility_type] || 0) + 1;
      if (o.status === 'active') activeCount++;
      if (o.status === 'scheduled') scheduledCount++;
    }

    const usersResult = await query('SELECT COUNT(*) FROM users', []);
    const addressesResult = await query('SELECT COUNT(*) FROM saved_addresses', []);

    res.json({
      success: true,
      data: {
        db_mode: dbStatus.mode,
        total_outages: outages.length,
        active_outages: activeCount,
        scheduled_outages: scheduledCount,
        outages_by_utility: byUtility,
        total_users: (usersResult && usersResult.rows) ? Number(usersResult.rows[0].count) : inMemoryDB.users.length,
        total_saved_addresses: (addressesResult && addressesResult.rows) ? Number(addressesResult.rows[0].count) : inMemoryDB.saved_addresses.length,
        active_visitors_now: getActiveVisitorCount(),
        total_logins: inMemoryDB.siteStats?.totalLogins || 0,
        scraper: getScraperStatus(),
        push_notifications_live: isFirebaseInitialized(),
        data_integrity_sweep: getLastIntegritySweepResult(),
        last_prune: getLastPruneResult()
      }
    });
  } catch (err) {
    next(err);
  }
}
