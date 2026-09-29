// Backward-compatible barrel — callers may continue to require this module.
const config = require('./stellar-config');
const accounts = require('./stellar-accounts');
const payments = require('./stellar-payments');
const contracts = require('./stellar-contracts');

module.exports = { ...config, ...accounts, ...payments, ...contracts };
