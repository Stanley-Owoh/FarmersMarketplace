-- #1368: Contract alerts shown on the admin dashboard
-- (GET /api/admin/contract-alerts, PATCH|POST /api/admin/contract-alerts/:id/acknowledge).
--
-- Rows are written by jobs/contractMonitor.js when it can't read a contract's
-- events after all retries, alongside the admin alert email.
--
-- Columns:
--   contract_id     — Soroban contract the alert is about
--   alert_type      — e.g. 'monitor_failure', 'failed_invocations', 'large_transfer'
--   severity        — 'info' | 'warning' | 'critical'
--   message         — human-readable detail
--   acknowledged    — 0/1, set by an admin from the dashboard
--   acknowledged_by — admin user id who acknowledged it
--   acknowledged_at — when it was acknowledged

CREATE TABLE IF NOT EXISTS contract_alerts (
  id              INTEGER  PRIMARY KEY AUTOINCREMENT,
  contract_id     TEXT     NOT NULL,
  alert_type      TEXT     NOT NULL,
  severity        TEXT     NOT NULL DEFAULT 'warning',
  message         TEXT     NOT NULL,
  acknowledged    INTEGER  NOT NULL DEFAULT 0,
  acknowledged_by INTEGER  REFERENCES users(id),
  acknowledged_at DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contract_alerts_acknowledged
  ON contract_alerts(acknowledged, created_at);

CREATE INDEX IF NOT EXISTS idx_contract_alerts_contract_id
  ON contract_alerts(contract_id);
