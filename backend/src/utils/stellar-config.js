// Shared Stellar network configuration for account/key-derivation utilities.
// Kept separate from stellar.js so key-management code (stellar-accounts.js)
// does not need to pull in the full payments/escrow module surface.
const StellarSdk = require('@stellar/stellar-sdk');
const logger = require('../logger');

const STELLAR_NETWORK = (process.env.STELLAR_NETWORK || 'testnet').toLowerCase();

if (!['testnet', 'mainnet'].includes(STELLAR_NETWORK)) {
  throw new Error(`Invalid STELLAR_NETWORK "${STELLAR_NETWORK}". Must be "testnet" or "mainnet".`);
}

if (STELLAR_NETWORK === 'mainnet' && process.env.STELLAR_MAINNET_CONFIRMED !== 'true') {
  throw new Error(
    'Mainnet use requires STELLAR_MAINNET_CONFIRMED=true in your environment. ' +
      'This guard prevents accidental real-fund transactions.'
  );
}

const isTestnet = STELLAR_NETWORK === 'testnet';
const horizonUrl =
  process.env.STELLAR_HORIZON_URL ||
  (isTestnet ? 'https://horizon-testnet.stellar.org' : 'https://horizon.stellar.org');
const sorobanRpcUrl =
  process.env.SOROBAN_RPC_URL ||
  (isTestnet ? 'https://soroban-testnet.stellar.org' : 'https://soroban.stellar.org');
const networkPassphrase = isTestnet ? StellarSdk.Networks.TESTNET : StellarSdk.Networks.PUBLIC;
const server = new StellarSdk.Horizon.Server(horizonUrl);
const sorobanServer = new StellarSdk.SorobanRpc.Server(sorobanRpcUrl);

const REQUIRED_STELLAR_VARS = [
  'SOROBAN_ESCROW_CONTRACT_ID',
  'SOROBAN_XLM_TOKEN_CONTRACT_ID',
];

const OPTIONAL_STELLAR_VARS = ['REWARD_TOKEN_CONTRACT_ID', 'REWARD_TOKEN_ADMIN_SECRET'];

function validateStellarConfig() {
  const network = isTestnet ? 'testnet' : 'mainnet';
  logger.info(`[stellar-config] Validating Stellar config for ${network} (${networkPassphrase})`);

  const resolved = {
    SOROBAN_RPC_URL: sorobanRpcUrl,
    SOROBAN_ESCROW_CONTRACT_ID: process.env.SOROBAN_ESCROW_CONTRACT_ID,
    SOROBAN_XLM_TOKEN_CONTRACT_ID: process.env.SOROBAN_XLM_TOKEN_CONTRACT_ID,
  };

  const missing = REQUIRED_STELLAR_VARS.filter((name) => !resolved[name]);
  if (missing.length > 0) {
    throw new Error(
      `[stellar-config] Missing required Stellar/Soroban environment variable(s): ${missing.join(', ')}. ` +
        `Detected network: ${network}. Copy backend/.env.example to backend/.env and set these values.`
    );
  }

  for (const name of OPTIONAL_STELLAR_VARS) {
    if (!process.env[name]) {
      logger.warn(`[stellar-config] Optional variable ${name} is not set; related features are disabled.`);
    }
  }

  return { network, networkPassphrase };
}

module.exports = {
  StellarSdk,
  STELLAR_NETWORK,
  isTestnet,
  horizonUrl,
  sorobanRpcUrl,
  networkPassphrase,
  server,
  sorobanServer,
  validateStellarConfig,
};
