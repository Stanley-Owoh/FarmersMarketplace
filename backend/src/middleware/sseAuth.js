'use strict';

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const User = require('../models/User');

// Per-user cap on concurrent SSE connections. When exceeded, the oldest
// connection is closed so a single account cannot exhaust server resources
// by opening many tabs.
const MAX_SSE_CONNECTIONS_PER_USER = 5;

// userId -> array of { res, close } entries, oldest first.
const sseConnections = new Map();

function registerSseConnection(userId, res) {
  const key = String(userId);
  let conns = sseConnections.get(key);
  if (!conns) {
    conns = [];
    sseConnections.set(key, conns);
  }

  const entry = { res };
  conns.push(entry);

  // Enforce the cap by closing the oldest connections first.
  while (conns.length > MAX_SSE_CONNECTIONS_PER_USER) {
    const oldest = conns.shift();
    try {
      oldest.res.end();
    } catch (err) {
      // Connection may already be gone; ignore.
    }
  }

  const cleanup = () => {
    const list = sseConnections.get(key);
    if (!list) return;
    const idx = list.indexOf(entry);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) sseConnections.delete(key);
  };

  res.on('close', cleanup);
  res.on('finish', cleanup);

  return cleanup;
}

/**
 * Shared authentication middleware for every SSE endpoint.
 *
 * Only short-lived tokens minted by `GET /auth/stream-token` (scope: 'stream')
 * are accepted. Full access tokens passed in the query string are rejected so
 * long-lived bearer tokens never end up in access logs, proxy logs, browser
 * history or Referer headers.
 *
 * The account must still exist, be active and not banned.
 */
async function sseAuth(req, res, next) {
  const token = req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Missing stream token' });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired stream token' });
  }

  // Reject full access tokens: only stream-scoped tokens are allowed here.
  if (payload.scope !== 'stream') {
    return res.status(403).json({ error: 'A stream token is required' });
  }

  try {
    const user = await User.findById(payload.sub || payload.id);
    if (!user) {
      return res.status(401).json({ error: 'Invalid stream token' });
    }
    if (user.banned || user.isBanned) {
      return res.status(403).json({ error: 'Account is banned' });
    }
    if (user.active === false || user.isActive === false) {
      return res.status(403).json({ error: 'Account is not active' });
    }

    req.user = user;
    req.userId = user.id || user._id;
    return next();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to authenticate stream token' });
  }
}

module.exports = sseAuth;
module.exports.sseAuth = sseAuth;
module.exports.registerSseConnection = registerSseConnection;
module.exports.MAX_SSE_CONNECTIONS_PER_USER = MAX_SSE_CONNECTIONS_PER_USER;
