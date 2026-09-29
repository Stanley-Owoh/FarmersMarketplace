const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const logger = require('../logger');
const db = require('../db/schema');
const { Server } = require('@stellar/stellar-sdk');

// ============================================================================
// Rate Limiters
// ============================================================================

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_AUTH_MAX || '10'),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many attempts, try again later',
    code: 'rate_limited',
  },
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_GENERAL_MAX || '100'),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests, slow down',
    code: 'rate_limited',
  },
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_ORDER_MAX || '10'),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many orders, slow down',
    code: 'rate_limited',
  },
});

const fundLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Funding limit reached, try again in an hour',
    code: 'rate_limited',
  },
});

const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_SEND_MAX || '5'),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many send requests, slow down',
    code: 'rate_limited',
  },
});

// ============================================================================
// Health Checks
// ============================================================================

async function checkDatabase() {
  const startTime = Date.now();
  try {
    await db.query('SELECT 1');
    const duration = Date.now() - startTime;
    return { status: 'ok', responseTime: `${duration}ms` };
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Database health check failed:', { error: error.message });
    return { status: 'down', responseTime: `${duration}ms`, error: error.message };
  }
}

async function checkStellarHorizon(requestId) {
  const startTime = Date.now();
  try {
    const horizonUrl = process.env.STELLAR_HORIZON_URL || 
      (process.env.STELLAR_NETWORK === 'mainnet' 
        ? 'https://horizon.stellar.org' 
        : 'https://horizon-testnet.stellar.org');
    const server = new Server(horizonUrl);
    await server.root();
    const duration = Date.now() - startTime;
    logger.info(JSON.stringify({ requestId: requestId || null, event: 'horizon_health_check', status: 'ok', responseTime: `${duration}ms` }));
    return { status: 'ok', responseTime: `${duration}ms` };
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Stellar Horizon health check failed:', { requestId: requestId || null, error: error.message });
    return { status: 'down', responseTime: `${duration}ms`, error: error.message };
  }
}

async function checkSorobanRPC(requestId) {
  const startTime = Date.now();
  try {
    const sorobanUrl = process.env.SOROBAN_RPC_URL;
    if (!sorobanUrl) {
      return { status: 'not_configured', responseTime: '0ms' };
    }
    
    const https = require('https');
    const url = new URL(sorobanUrl);
    
    const postData = JSON.stringify({ 
      jsonrpc: '2.0', 
      id: 1, 
      method: 'getHealth' 
    });
    
    return new Promise((resolve) => {
      const req = https.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const duration = Date.now() - startTime;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const result = JSON.parse(data);
              resolve({ status: 'ok', responseTime: `${duration}ms`, details: result });
            } catch (parseError) {
              resolve({ status: 'down', responseTime: `${duration}ms`, error: 'Invalid JSON response' });
            }
          } else {
            resolve({ status: 'down', responseTime: `${duration}ms`, error: `HTTP ${res.statusCode}` });
          }
        });
      });
      
      req.on('error', (error) => {
        const duration = Date.now() - startTime;
        logger.error('Soroban RPC health check failed:', { requestId: requestId || null, error: error.message });
        resolve({ status: 'down', responseTime: `${duration}ms`, error: error.message });
      });
      
      req.write(postData);
      req.end();
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Soroban RPC health check failed:', { error: error.message });
    return { status: 'down', responseTime: `${duration}ms`, error: error.message };
  }
}

async function checkRedis() {
  const startTime = Date.now();
  try {
    if (!process.env.REDIS_URL) {
      return { status: 'not_configured', responseTime: '0ms' };
    }
    let Redis;
    try {
      Redis = require('ioredis');
    } catch {
      return { status: 'not_available', responseTime: '0ms', error: 'ioredis not installed' };
    }
    const testClient = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 3000
    });
    await testClient.ping();
    testClient.disconnect();
    const duration = Date.now() - startTime;
    return { status: 'ok', responseTime: `${duration}ms` };
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Redis health check failed:', { error: error.message });
    return { status: 'down', responseTime: `${duration}ms`, error: error.message };
  }
}

// ============================================================================
// Health Endpoint Handler
// ============================================================================

async function getHealthCheckResponse(includeVersion = false, requestId) {
  const startTime = Date.now();
  try {
    const [dbCheck, horizonCheck, sorobanCheck, redisCheck] = await Promise.all([
      checkDatabase(),
      checkStellarHorizon(requestId),
      checkSorobanRPC(requestId),
      checkRedis()
    ]);

    const checks = {
      database: dbCheck,
      horizon: horizonCheck,
      soroban: sorobanCheck,
      redis: redisCheck
    };
    
    const criticalDown = [dbCheck.status, horizonCheck.status].some(status => status === 'down');
    const overallStatus = criticalDown ? 'down' : 'ok';
    
    const uptime = process.uptime();
    const responseTime = Date.now() - startTime;
    
    const healthData = {
      status: overallStatus,
      uptime: Math.floor(uptime),
      responseTime: `${responseTime}ms`,
      checks,
      timestamp: new Date().toISOString()
    };

    if (includeVersion) {
      healthData.version = 'v1';
    }

    return { healthData, statusCode: overallStatus === 'down' ? 503 : 200 };
  } catch (error) {
    logger.error('Health check error:', { error: error.message });
    return {
      healthData: {
        status: 'down',
        error: 'Health check failed',
        timestamp: new Date().toISOString(),
        ...(includeVersion && { version: 'v1' })
      },
      statusCode: 503
    };
  }
}

// ============================================================================
// Deprecation Middleware
// ============================================================================

/**
 * Fixed sunset date for the deprecated API v0 surface.
 *
 * Sourced from config (`API_V0_SUNSET`, default `2027-03-31`) so the value is
 * stable across requests and clients can plan a migration. Previously this was
 * computed as `now + 180 days` on every request, which meant the sunset date
 * never actually arrived.
 */
const API_V0_SUNSET = process.env.API_V0_SUNSET || '2027-03-31';

/**
 * Add deprecation warn

/* … truncated 6657 chars — edit only what you need near the top … */
