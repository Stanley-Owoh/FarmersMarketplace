jest.mock('../db/schema', () => ({ query: jest.fn() }));

const express = require('express');
const request = require('supertest');
const db = require('../db/schema');
const requireEmailVerified = require('../middleware/requireEmailVerified');

function buildApp(jwtVerificationState) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 7, email_verified_at: jwtVerificationState };
    next();
  });
  app.post('/', requireEmailVerified, (_req, res) => res.sendStatus(204));
  return app;
}

describe('requireEmailVerified', () => {
  beforeEach(() => jest.clearAllMocks());

  it('blocks a JWT that claims verification when the database says unverified', async () => {
    db.query.mockResolvedValue({ rows: [{ email_verified_at: null }] });

    const response = await request(buildApp('stale-verified-claim')).post('/');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('email_not_verified');
  });

  it('allows a verified user even when the JWT has no verification claim', async () => {
    db.query.mockResolvedValue({ rows: [{ email_verified_at: '2026-09-29T00:00:00.000Z' }] });

    const response = await request(buildApp(undefined)).post('/');

    expect(response.status).toBe(204);
    expect(db.query).toHaveBeenCalledWith('SELECT email_verified_at FROM users WHERE id = $1', [7]);
  });

  it('forwards database errors to Express error handling', async () => {
    db.query.mockRejectedValue(new Error('database unavailable'));
    const app = buildApp(undefined);
    app.use((error, _req, res, _next) => res.status(500).send(error.message));

    const response = await request(app).post('/');

    expect(response.status).toBe(500);
    expect(response.text).toBe('database unavailable');
  });
});
