const request = require('supertest');
const app = require('../app');

describe('API route mounts', () => {
  it('serves the versioned CSRF token endpoint', async () => {
    const response = await request(app).get('/api/v1/csrf-token');

    expect(response.status).toBe(200);
    expect(response.body).not.toEqual({ success: true, data: [] });
  });

  it.each([
    ['get', '/api/v1/not-a-route'],
    ['delete', '/api/v1/not-a-route'],
    ['post', '/api/v1'],
  ])('does not route %s %s through reviews', async (method, path) => {
    const response = await request(app)[method](path);

    expect(response.status).toBe(404);
    expect(response.body).not.toEqual({ success: true, data: [] });
  });
});
