const express = require('express');
const request = require('supertest');
const routes = jest.requireActual('../routes/index');
const db = jest.requireMock('../db/schema');

const app = express();
app.use(express.json());
app.use(routes);

beforeEach(() => {
  jest.clearAllMocks();
  db.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('product route ordering', () => {
  it('routes product export to the authenticated export handler', async () => {
    const response = await request(app).get('/api/v1/products/export');

    expect(response.status).toBe(401);
    expect(response.body.error).not.toBe('Product not found');
  });

  it('serves product categories before the product-id lookup', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, name: 'Vegetables', slug: 'vegetables', product_count: 4 }],
      rowCount: 1,
    });

    const response = await request(app).get('/api/v1/products/categories');

    expect(response.status).toBe(200);
    expect(response.body.data[0].slug).toBe('vegetables');
  });

  it('routes product search through the shared product-list handler', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await request(app).get('/api/v1/products/search?q=tomato');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(db.query.mock.calls[0][0]).toContain('COUNT(*)');
    expect(db.query.mock.calls[0][1]).toContain('%tomato%');
  });

  it('routes the products market alias before the product-id lookup', async () => {
    const response = await request(app).get('/api/v1/products/market');

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('error', 'Product not found');
  });

  it('mounts share endpoints at /products/:id/share', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 7, name: 'Tomatoes', description: null, image_url: null, farmer_name: 'Alice' }],
      rowCount: 1,
    });

    const response = await request(app).get('/api/v1/products/7/share');

    expect(response.status).toBe(200);
    expect(response.body.data.productId).toBe(7);
  });
});
