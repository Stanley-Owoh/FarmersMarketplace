/**
 * Account (wallet activity) alerts — written by jobs/activityMonitor.js.
 *
 * Mounted at /wallet/alerts, which is where the SPA calls them. These handlers
 * used to live in routes/alerts.js, whose router is mounted at /alerts, which
 * put them at /alerts/alerts (and GET /alerts/:id shadowed them anyway).
 */

const router = require('express').Router();
const db = require('../db/schema');
const auth = require('../middleware/auth');
const { err } = require('../middleware/error');

// GET /api/wallet/alerts — latest alerts for the authenticated user
router.get('/', auth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, type, message, read_at, created_at
     FROM account_alerts
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.user.id]
  );
  const unreadCount = rows.filter((r) => !r.read_at).length;
  res.json({ success: true, data: rows, unreadCount });
});

// PATCH /api/wallet/alerts/:id/read — mark an alert as read
router.patch('/:id/read', auth, async (req, res) => {
  const { rowCount } = await db.query(
    `UPDATE account_alerts SET read_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
    [req.params.id, req.user.id]
  );
  if (rowCount === 0) return err(res, 404, 'Alert not found or already read', 'not_found');
  res.json({ success: true });
});

module.exports = router;
