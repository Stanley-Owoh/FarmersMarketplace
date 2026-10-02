'use strict';

/**
 * Contract test between the SPA and the API (#1368).
 *
 * Reads every endpoint frontend/src/api/client.js calls and asserts that each
 * one resolves to a real route handler in the Express app (i.e. would not fall
 * through to the 404 handler), and that it is documented in the OpenAPI spec.
 *
 * Resolution walks app._router.stack the same way Express dispatches, so no
 * handler runs and no DB/network is touched. The root-mounted reviews router's
 * `GET /:productId` matches almost any single-segment GET (#1340), so a path that
 * only resolves there counts as unresolved.
 */

const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const reviewsRouter = require('../src/routes/reviews');
const swaggerSpec = require('../src/swagger');

const CLIENT_PATH = path.join(__dirname, '../../frontend/src/api/client.js');

// SPA paths outside #1368's scope that still have no backend route. Each needs
// a backend endpoint or an SPA change (frontend #1382); remove entries as they land.
const KNOWN_GAPS = new Set([
  'GET /admin/contracts',
  'POST /admin/contracts',
  'POST /admin/contracts/deploy',
  'DELETE /admin/contracts/{}',
  'GET /admin/contracts/{}/acl',
  'POST /admin/contracts/{}/acl',
  'DELETE /admin/contracts/{}/acl/{}',
  'GET /admin/contracts/{}/compare',
  'GET /admin/contracts/{}/invocations',
  'GET /admin/contracts/{}/state/export',
  'POST /admin/contracts/{}/upgrade',
  'GET /admin/contracts/{}/upgrades',
  'GET /export/orders',
  'GET /farmers/me/bundle-discounts',
  'POST /farmers/me/bundle-discounts',
  'PUT /farmers/me/bundle-discounts/{}',
  'DELETE /farmers/me/bundle-discounts/{}',
  'GET /orders/{}/receipt',
  'GET /orders/{}/status',
  'PATCH /orders/{}/return/approve',
  'PATCH /orders/{}/return/reject',
  'POST /products/import/confirm',
  'POST /products/{}/video',
  'POST /products/{}/waitlist',
  'DELETE /products/{}/waitlist',
  'GET /products/{}/waitlist/status',
  'GET /wallet/earnings',
  'POST /wallet/earnings/claim',
  'GET /wallet/path-estimate',
]);

// The rows of the #1368 table — these must always resolve.
const ISSUE_1368_ENDPOINTS = [
  'GET /products/categories',
  'GET /products/search',
  'POST /products/upload-image',
  'PATCH /products/bulk-price',
  'PATCH /products/{}/flash-sale',
  'DELETE /products/{}/flash-sale',
  'GET /products/{}/share',
  'POST /products/{}/share',
  'GET /wallet/alerts',
  'PATCH /wallet/alerts/{}/read',
  'GET /streams',
  'POST /streams',
  'POST /streams/{}/withdraw',
  'POST /streams/{}/cancel',
  'PATCH /streams/{}/decrease-rate',
  'POST /orders/{}/claim',
  'POST /orders/{}/claim-preorder',
  'GET /admin/contract-alerts',
  'PATCH /admin/contract-alerts/{}/acknowledge',
  'POST /admin/contract-alerts/{}/acknowledge',
];

/** Normalises a client.js path template: drops query strings and turns ${…} into {}. */
function normalisePath(raw) {
  let p = raw.split('${toQs')[0].replace(/\$\{qs\}/g, '');
  p = p.replace(/\$\{[^}]*(\?|!==)[\s\S]*$/, ''); // `${cond ? '?x=' : ''}` suffixes
  p = p.split('?')[0];
  return p.replace(/\$\{[^}]*\}/g, '{}');
}

/** Extracts ["METHOD /path"] for every request()/fetch(`${BASE}…`) call in client.js. */
function extractClientEndpoints(source) {
  const endpoints = new Set();
  const requestRe = /request\(\s*([`'"])([\s\S]*?)\1\s*(?:,\s*\{([^}]*)\})?/g;
  for (const m of source.matchAll(requestRe)) {
    const method = (/method:\s*['"](\w+)['"]/.exec(m[3] || '') || [, 'GET'])[1].toUpperCase();
    const p = normalisePath(m[2]);
    if (p.startsWith('/')) endpoints.add(`${method} ${p}`);
  }
  const fetchRe = /fetch\(`\$\{BASE\}([^`]*)`\s*(?:,\s*\{([^}]*)\})?/g;
  for (const m of source.matchAll(fetchRe)) {
    const method = (/method:\s*['"](\w+)['"]/.exec(m[2] || '') || [, 'GET'])[1].toUpperCase();
    const p = normalisePath(m[1]);
    if (p.startsWith('/')) endpoints.add(`${method} ${p}`); // skips request()'s own `${BASE}${path}`
  }
  return [...endpoints].sort();
}

/**
 * Returns { route, router } for the first route that Express would dispatch
 * `method path` to, or null. Middleware-only layers are skipped because they
 * call next() for paths they don't own.
 */
function resolve(stack, method, urlPath, router = null) {
  for (const layer of stack) {
    if (!layer.match(urlPath)) continue;
    if (layer.route) {
      if (layer.route._handles_method(method.toLowerCase())) return { route: layer.route, router };
      continue;
    }
    if (layer.handle && Array.isArray(layer.handle.stack)) {
      const rest = urlPath.slice(layer.path.length) || '/';
      const found = resolve(layer.handle.stack, method, rest.startsWith('/') ? rest : `/${rest}`, layer.handle);
      if (found) return found;
    }
  }
  return null;
}

function resolvesToRealHandler(endpoint) {
  const [method, template] = endpoint.split(' ');
  const urlPath = `/api/v1${template.replace(/\{\}/g, '1')}`;
  const found = resolve(app._router.stack, method, urlPath);
  if (!found) return false;
  return !(found.router === reviewsRouter && found.route.path === '/:productId');
}

const clientEndpoints = extractClientEndpoints(fs.readFileSync(CLIENT_PATH, 'utf8'));

describe('SPA ↔ API route contract (#1368)', () => {
  it('finds the SPA endpoints in client.js', () => {
    expect(clientEndpoints.length).toBeGreaterThan(100);
  });

  it.each(ISSUE_1368_ENDPOINTS)('%s resolves to a handler', (endpoint) => {
    expect(resolvesToRealHandler(endpoint)).toBe(true);
  });

  it('every endpoint client.js calls resolves to a non-404 handler (minus known gaps)', () => {
    const unresolved = clientEndpoints.filter((e) => !KNOWN_GAPS.has(e) && !resolvesToRealHandler(e));
    expect(unresolved).toEqual([]);
  });

  it('known gaps are still gaps (remove them from KNOWN_GAPS once fixed)', () => {
    const fixed = [...KNOWN_GAPS].filter((e) => resolvesToRealHandler(e));
    expect(fixed).toEqual([]);
  });

  it('every endpoint client.js calls is documented in the OpenAPI spec', () => {
    const documented = new Set();
    for (const [specPath, ops] of Object.entries(swaggerSpec.paths || {})) {
      const template = specPath.replace(/^\/api(\/v1)?/, '').replace(/\{[^}]+\}/g, '{}');
      for (const method of Object.keys(ops)) documented.add(`${method.toUpperCase()} ${template}`);
    }
    const undocumented = clientEndpoints.filter((e) => !documented.has(e));
    expect(undocumented).toEqual([]);
  });
});
