const db = require('../db/schema');
const { getTransactions } = require('../utils/stellar');
const logger = require('../logger');

// Orders sit in 'confirming' for at most TIMEOUT_MS, so poll well inside that window.
const POLL_INTERVAL_MS = parseInt(process.env.CONFIRM_PAYMENTS_INTERVAL_MS || '15000', 10);
const TIMEOUT_MS = 60000;

/**
 * Settles orders in 'confirming': marks them paid once their Stellar tx shows up
 * on the buyer's account, or failed (restocking the product) after TIMEOUT_MS.
 * Scheduled by jobs/index.js.
 */
async function confirmPendingOrders() {
  const { rows: confirming } = await db.query(
    `SELECT o.*, u.stellar_public_key
     FROM orders o JOIN users u ON o.buyer_id = u.id
     WHERE o.status = 'confirming' AND o.stellar_tx_hash IS NOT NULL`
  );

  for (const order of confirming) {
    const submittedAt = new Date(order.tx_submitted_at).getTime();
    if (Date.now() - submittedAt > TIMEOUT_MS) {
      await db.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [order.id]);
      await db.query(`UPDATE products SET quantity = quantity + $1 WHERE id = $2`, [
        order.quantity,
        order.product_id,
      ]);
      logger.info(`[confirm] Order ${order.id} timed out`);
      continue;
    }

    try {
      const txs = await getTransactions(order.stellar_public_key);
      const confirmed = txs.some((tx) => tx.hash === order.stellar_tx_hash);
      if (confirmed) {
        await db.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
        logger.info(`[confirm] Order ${order.id} confirmed — TX ${order.stellar_tx_hash}`);
      }
    } catch (e) {
      logger.error(`[confirm] Error checking order ${order.id}`, { error: e.message });
    }
  }
}

module.exports = { confirmPendingOrders, POLL_INTERVAL_MS };
