require('./config'); // validate env vars before anything else
const { validateStellarConfig } = require('./utils/stellar-config');
validateStellarConfig(); // fail fast on missing Stellar/Soroban config
const app = require('./app');
const logger = require('./logger');
const { startJobs } = require('./jobs');
const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  logger.info(`Backend running on http://localhost:${PORT}`);
  // Background jobs run only in the process started with RUN_JOBS=true (#1367).
  startJobs();
});
