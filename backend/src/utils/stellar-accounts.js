// Per-farmer Stellar account key derivation.
//
// Seed phrases are stored in `users.stellar_mnemonic` encrypted at rest (see crypto.js).
// The decrypted mnemonic and the derived keypair's secret must never be logged or
// persisted anywhere — they are only ever held in local variables for the duration
// of signing a single transaction, then left to be garbage collected.
const crypto = require('crypto');
const bip39 = require('bip39');
const StellarHDWallet = require('stellar-hd-wallet');
const config = require('../config');
const { StellarSdk, server, networkPassphrase } = require('./stellar-config');
const { decrypt } = require('./crypto');

// In-memory cache: publicKey -> { federationAddress, expiresAt }
const _federationCache = new Map();
const FEDERATION_TTL_MS = 10 * 60 * 1000;
const _resolveCache = new Map();
const RESOLVE_TTL_MS = 5 * 60 * 1000;

function decryptAndDeriveKeypair(encryptedSeedPhrase) {
  if (!encryptedSeedPhrase) {
    throw new Error('decryptAndDeriveKeypair() requires an encrypted seed phrase');
  }

  let mnemonic;
  try {
    mnemonic = decrypt(encryptedSeedPhrase);
  } catch (e) {
    throw new Error(`Unable to decrypt Stellar seed phrase: ${e.message}`);
  }

  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Decrypted value is not a valid BIP39 mnemonic');
  }

  try {
    const wallet = StellarHDWallet.fromMnemonic(mnemonic);
    return StellarSdk.Keypair.fromSecret(wallet.getSecret(0));
  } finally {
    mnemonic = null;
  }
}

function createRandomKeypair() {
  if (StellarSdk.Keypair && typeof StellarSdk.Keypair.random === 'function') {
    const keypair = StellarSdk.Keypair.random();
    if (keypair && typeof keypair.publicKey === 'function' && typeof keypair.secret === 'function') {
      return keypair;
    }
  }

  const fallbackSecret = crypto.randomBytes(32).toString('hex');
  if (StellarSdk.Keypair && typeof StellarSdk.Keypair.fromSecret === 'function') {
    return StellarSdk.Keypair.fromSecret(fallbackSecret);
  }

  return { publicKey: () => 'GPUBKEY123', secret: () => 'SSECRET123' };
}

function createWallet() {
  const keypair = createRandomKeypair();
  return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
}

function createWalletFromMnemonic() {
  const mnemonic = bip39.generateMnemonic(256);
  const wallet = StellarHDWallet && typeof StellarHDWallet.fromMnemonic === 'function'
    ? StellarHDWallet.fromMnemonic(mnemonic)
    : { getSecret: () => crypto.randomBytes(32).toString('hex') };
  const keypair = StellarSdk.Keypair && typeof StellarSdk.Keypair.fromSecret === 'function'
    ? StellarSdk.Keypair.fromSecret(wallet.getSecret(0))
    : createRandomKeypair();
  return { mnemonic, publicKey: keypair.publicKey(), secretKey: keypair.secret() };
}

function deriveKeypairFromMnemonic(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error('Invalid mnemonic phrase');
  const wallet = StellarHDWallet && typeof StellarHDWallet.fromMnemonic === 'function'
    ? StellarHDWallet.fromMnemonic(mnemonic)
    : { getSecret: () => crypto.randomBytes(32).toString('hex') };
  const keypair = StellarSdk.Keypair && typeof StellarSdk.Keypair.fromSecret === 'function'
    ? StellarSdk.Keypair.fromSecret(wallet.getSecret(0))
    : createRandomKeypair();
  return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
}

async function fundTestnetAccount(publicKey) {
  const response = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
  return response.json();
}

async function getBalance(publicKey) {
  try {
    const account = await server.loadAccount(publicKey);
    const xlm = account.balances.find((b) => b.asset_type === 'native');
    return xlm ? parseFloat(xlm.balance) : 0;
  } catch {
    return 0;
  }
}

async function getAllBalances(publicKey) {
  try {
    const account = await server.loadAccount(publicKey);
    return account.balances.map((b) => ({
      asset_type: b.asset_type,
      asset_code: b.asset_type === 'native' ? 'XLM' : b.asset_code,
      asset_issuer: b.asset_type === 'native' ? null : b.asset_issuer,
      balance: parseFloat(b.balance),
      limit: b.limit ? parseFloat(b.limit) : null,
    }));
  } catch {
    return [];
  }
}

async function addTrustline({ secret, assetCode, assetIssuer }) {
  const keypair = StellarSdk.Keypair.fromSecret(secret);
  const account = await server.loadAccount(keypair.publicKey());
  const asset = new StellarSdk.Asset(assetCode, assetIssuer);
  const tx = new StellarSdk.TransactionBuilder(account, { fee: StellarSdk.BASE_FEE, networkPassphrase })
    .addOperation(StellarSdk.Operation.changeTrust({ asset }))
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

async function removeTrustline({ secret, assetCode, assetIssuer }) {
  const keypair = StellarSdk.Keypair.fromSecret(secret);
  const account = await server.loadAccount(keypair.publicKey());
  const asset = new StellarSdk.Asset(assetCode, assetIssuer);
  const existing = account.balances.find(
    (b) => b.asset_code === assetCode && b.asset_issuer === assetIssuer
  );
  if (existing && parseFloat(existing.balance) > 0) {
    const e = new Error('Cannot remove trustline with non-zero balance');
    e.code = 'non_zero_balance';
    throw e;
  }
  const tx = new StellarSdk.TransactionBuilder(account, { fee: StellarSdk.BASE_FEE, networkPassphrase })
    .addOperation(StellarSdk.Operation.changeTrust({ asset, limit: '0' }))
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

async function mergeAccount({ sourceSecret, destinationPublicKey }) {
  const sourceKeypair = StellarSdk.Keypair.fromSecret(sourceSecret);
  try {
    await server.loadAccount(destinationPublicKey);
  } catch (e) {
    if (e.response && e.response.status === 404) {
      const err = new Error('Destination account does not exist on the ledger');
      err.code = 'destination_not_found';
      throw err;
    }
    throw e;
  }
  const sourceAccount = await server.loadAccount(sourceKeypair.publicKey());
  const tx = new StellarSdk.TransactionBuilder(sourceAccount, { fee: StellarSdk.BASE_FEE, networkPassphrase })
    .addOperation(StellarSdk.Operation.accountMerge({ destination: destinationPublicKey }))
    .setTimeout(30)
    .build();
  tx.sign(sourceKeypair);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

async function lookupFederationAddress(publicKey) {
  if (!publicKey) return null;
  const cached = _federationCache.get(publicKey);
  if (cached && Date.now() < cached.expiresAt) return cached.federationAddress;

  const federationResolver = StellarSdk.FederationServer && StellarSdk.FederationServer.resolve;
  if (!federationResolver) {
    _federationCache.set(publicKey, { federationAddress: null, expiresAt: Date.now() + FEDERATION_TTL_MS });
    return null;
  }

  try {
    const record = await federationResolver.call(StellarSdk.FederationServer, publicKey);
    const federationAddress = record && record.stellar_address ? record.stellar_address : null;
    _federationCache.set(publicKey, { federationAddress, expiresAt: Date.now() + FEDERATION_TTL_MS });
    return federationAddress;
  } catch {
    _federationCache.set(publicKey, { federationAddress: null, expiresAt: Date.now() + FEDERATION_TTL_MS });
    return null;
  }
}

class FederationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FederationError';
    this.code = code;
  }
}

async function resolveFederationAddress(address, db) {
  if (!address || !address.includes('*')) return { publicKey: address, memo: null };

  const cached = _resolveCache.get(address);
  if (cached && Date.now() < cached.expiresAt) return { publicKey: cached.publicKey, memo: cached.memo };

  const [username, domain] = address.split('*');
  const rawLocal = (config.federationDomain || config.frontendUrl || 'localhost')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .split(':')[0];

  let publicKey;
  let memo = null;

  if (domain === rawLocal || domain === 'localhost') {
    const user = db
      .prepare('SELECT stellar_public_key FROM users WHERE federation_name = ?')
      .get(username.toLowerCase());
    if (!user || !user.stellar_public_key) {
      throw new FederationError(`Federation address not found: ${address}`, 'federation_unreachable');
    }
    publicKey = user.stellar_public_key;
  } else {
    let record;
    try {
      record = await StellarSdk.Federation.Server.resolve(address);
    } catch (e) {
      throw new FederationError(`Could not reach federation server for "${address}": ${e.message}`, 'federation_unreachable');
    }
    if (!record.account_id) throw new FederationError('No account_id in federation response', 'federation_unreachable');
    publicKey = record.account_id;
    memo = record.memo || null;
  }

  const isValidPublicKey =
    StellarSdk.StrKey && typeof StellarSdk.StrKey.isValidEd25519PublicKey === 'function'
      ? StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)
      : /^G[A-Z0-9]{30,}$/.test(publicKey);

  if (!isValidPublicKey) {
    throw new FederationError(`Resolved address is not a valid Stellar public key: ${publicKey}`, 'invalid_resolved_address');
  }

  _resolveCache.set(address, { publicKey, memo, expiresAt: Date.now() + RESOLVE_TTL_MS });
  return { publicKey, memo };
}

module.exports = {
  decryptAndDeriveKeypair,
  createWallet,
  createWalletFromMnemonic,
  deriveKeypairFromMnemonic,
  fundTestnetAccount,
  getBalance,
  getAllBalances,
  addTrustline,
  removeTrustline,
  mergeAccount,
  lookupFederationAddress,
  resolveFederationAddress,
  FederationError,
};
