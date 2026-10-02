/**
 * Shared test helpers.
 * The global beforeEach in jest.setup.js handles mock resets.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '10000';
process.env.RATE_LIMIT_GENERAL_MAX = '10000';
process.env.RATE_LIMIT_ORDER_MAX = '10000';
process.env.RATE_LIMIT_SEND_MAX = '10000';
process.env.RATE_LIMIT_LOGIN_MAX = '10000';
process.env.RATE_LIMIT_REGISTER_MAX = '10000';
process.env.RATE_LIMIT_ORDER_USER_MAX = '10000';

const appInstance = require('../src/app');
const mockDb = require('../src/db/schema');

function createLiveProxy(getter) {
  return new Proxy(
    function proxied() {},
    {
      get: (_, prop) => {
        const current = getter();
        const value = current?.[prop];
        return typeof value === 'function' ? value.bind(current) : value;
      },
      apply: (_, __, args) => getter()(...args),
    }
  );
}

function getPreparedStatement(method) {
  if (!mockDb.prepare.getMockImplementation()) {
    mockDb.prepare.mockReturnValue(mockDb.statementMocks);
  }
  return mockDb.prepare()[method];
}

const mockQueryProxy = createLiveProxy(() => mockDb.query);
const mockRunProxy = createLiveProxy(() => getPreparedStatement('run'));
const mockGetProxy = createLiveProxy(() => getPreparedStatement('get'));
const mockAllProxy = createLiveProxy(() => getPreparedStatement('all'));
const mockPrepareProxy = createLiveProxy(() => mockDb.prepare);
const mockTransactionProxy = createLiveProxy(() => mockDb.transaction);

const request = require('supertest');

async function getCsrf() {
  const res = await request(app).get('/api/csrf-token');
  const setCookie = res.headers['set-cookie'] || [];
  const cookieStr = setCookie.find((c) => c.startsWith('csrf_token=')) || '';
  const token = cookieStr.split(';')[0].split('=')[1];
  return { token, cookieStr };
}

const app = appInstance;
module.exports = {
  request,
  app,
  mockDb,
  get mockQuery() {
    return mockDb.query;
  },
  get mockRun() {
    return mockRunProxy;
  },
  get mockGet() {
    return mockGetProxy;
  },
  get mockAll() {
    return mockAllProxy;
  },
  get mockPrepare() {
    return mockPrepareProxy;
  },
  get mockTransaction() {
    return mockTransactionProxy;
  },
  getCsrf,
};
