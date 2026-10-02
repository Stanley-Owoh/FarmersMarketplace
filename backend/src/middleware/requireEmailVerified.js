const db = require('../db/schema');

module.exports = function requireEmailVerified(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized.' });
  db.query('SELECT email_verified_at FROM users WHERE id = $1', [req.user.id])
    .then(({ rows }) => {
      if (!rows[0]?.email_verified_at) {
        return res.status(403).json({
          error: 'Email not verified. Please check your inbox and verify your email.',
          code: 'email_not_verified',
        });
      }
      req.user.email_verified_at = rows[0].email_verified_at;
      next();
    })
    .catch(next);
};
