import { getNotificationHistoryForUser, sendTestNotification } from '../services/notificationService.js';
import { verifyAuthToken } from '../services/authService.js';

/**
 * GET /api/notifications/history/:userId
 * Returns this user's past notification history — outages that matched one
 * of their notification-enabled addresses, newest first. Lets someone who
 * missed the actual push (phone off, browser closed) check back later.
 *
 * Only meaningful for logged-in accounts (the frontend never calls this for
 * guests), so unlike the address endpoints this requires a real session
 * whose own userId matches the one being requested — otherwise anyone who
 * learned a user's id from elsewhere (a shared screenshot, a log line)
 * could read their outage/address history.
 */
export async function getNotificationHistoryHandler(req, res, next) {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Липсва потребителски идентификатор.' });
    }
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const session = verifyAuthToken(token);
    if (!session || session.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Достъпът е отказан.' });
    }
    const history = await getNotificationHistoryForUser(userId);
    return res.json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/notifications/test
 * Body: { addressId }
 * Sends one real push straight to that address's stored fcm_token and
 * returns Firebase's actual outcome (success + message id, or the specific
 * error) — a diagnostic tool for "I enabled it but nothing arrived".
 * Gated by requireAdmin in server.js.
 */
export async function sendTestNotificationHandler(req, res, next) {
  try {
    const { addressId } = req.body;
    if (!addressId) {
      return res.status(400).json({ success: false, message: 'Липсва addressId.' });
    }
    const result = await sendTestNotification(addressId);
    return res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
