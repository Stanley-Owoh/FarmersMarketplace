const db = require('../db/schema');
const { findIncomingPaymentsByMemo } = require('../utils/stellar');
const logger = require('../logger');
const { sendLowStockAlert } = require('../utils/mailer');
const { broadcastStockUpdate } = require('../utils/stockUpdates');

// Orders sit in 'confirming' for at most TIMEOUT_MS, so poll well inside that window.
const POLL_INTERVAL_MS = parseInt(process.env.CONFIRM_PAYMENTS_INTERVAL_MS || '15000', 10);
const TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 15000;
const PAYMENT_EXPIRY_MS = 30 * 60 * 1000;

/**
 * Settles orders in 'confirming': marks them paid once their Stellar tx shows up
 * on the buyer's account, or failed (restocking the product) after TIMEOUT_MS.
 * Scheduled by jobs/index.js.
 */
async function confirmPendingOrders() {
  const { rows: pendingOrders } = await db.query(
    `SELECT o.id, o.total_price, o.stellar_memo, o.quantity, o.product_id, o.created_at,
            p.farmer_id, u.stellar_public_key AS farmer_public_key
     FROM orders o
     JOIN products p ON p.id = o.product_id
     JOIN users u ON u.id = p.farmer_id
     WHERE o.status = 'pending'
       AND o.stellar_memo IS NOT NULL
       AND o.stellar_memo LIKE 'order:%'`
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
  const ordersByFarmer = new Map();
  for (const order of pendingOrders) {
    if (!order.farmer_public_key) {
      logger.warn('[confirm] SEP-0007 order has no farmer wallet', { orderId: order.id });
      continue;
    }
    const orders = ordersByFarmer.get(order.farmer_public_key) || [];
    orders.push(order);
    ordersByFarmer.set(order.farmer_public_key, orders);
  }

  for (const [farmerPublicKey, orders] of ordersByFarmer) {
    let payments;
    try {
      const txs = await getTransactions(order.stellar_public_key);
      const confirmed = txs.some((tx) => tx.hash === order.stellar_tx_hash);
      if (confirmed) {
        await db.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
        logger.info(`[confirm] Order ${order.id} confirmed — TX ${order.stellar_tx_hash}`);
      payments = await findIncomingPaymentsByMemo(
        farmerPublicKey,
        orders.map((order) => ({
          memo: order.stellar_memo,
          amount: order.total_price,
        }))
      );
    } catch (error) {
      logger.error('[confirm] Failed to check Horizon payments', {
        farmerPublicKey,
        error: error.message,
      });
      continue;
    }

    for (const order of orders) {
      const txHash = payments.get(order.stellar_memo);
      const ageMs = Date.now() - new Date(order.created_at).getTime();
      if (!txHash && (!Number.isFinite(ageMs) || ageMs < PAYMENT_EXPIRY_MS)) continue;

      try {
        const update = txHash
          ? await db.query(
              `UPDATE orders
               SET status = 'paid', stellar_tx_hash = $1
               WHERE id = $2 AND status = 'pending' AND stellar_memo = $3`,
              [txHash, order.id, order.stellar_memo]
            )
          : await db.query(
              `UPDATE orders SET status = 'failed'
               WHERE id = $1 AND status = 'pending' AND stellar_memo = $2`,
              [order.id, order.stellar_memo]
            );

        if (!update.rowCount) continue;
        if (txHash) {
          logger.info('[confirm] SEP-0007 order payment confirmed', {
            orderId: order.id,
            txHash,
          });
          await publishStockUpdate(order);
        } else {
          const { rows: restoredRows } = await db.query(
            'UPDATE products SET quantity = quantity + $1 WHERE id = $2 RETURNING quantity',
            [order.quantity, order.product_id]
          );
          if (restoredRows[0]) broadcastStockUpdate(order.product_id, restoredRows[0].quantity);
          logger.info('[confirm] Unpaid SEP-0007 order expired', { orderId: order.id });
        }
      } catch (error) {
        logger.error('[confirm] Failed to finalize SEP-0007 order', {
          orderId: order.id,
          error: error.message,
        });
      }
    }
  }
}

module.exports = { confirmPendingOrders, POLL_INTERVAL_MS };
async function publishStockUpdate(order) {
  try {
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.quantity, p.low_stock_threshold, p.low_stock_alerted,
              p.unit, u.id AS farmer_id, u.name AS farmer_name, u.email AS farmer_email
       FROM products p JOIN users u ON u.id = p.farmer_id
       WHERE p.id = $1`,
      [order.product_id]
    );
    const product = rows[0];
    if (!product) return;

    if (
      product.low_stock_threshold > 0 &&
      product.quantity <= product.low_stock_threshold &&
      !product.low_stock_alerted
    ) {
      await db.query('UPDATE products SET low_stock_alerted = 1 WHERE id = $1', [product.id]);
      sendLowStockAlert({
        product,
        farmer: {
          id: product.farmer_id,
          name: product.farmer_name,
          email: product.farmer_email,
        },
      })
        .catch((error) => logger.error('[confirm] Low-stock alert failed', { error: error.message }));
    }
    broadcastStockUpdate(product.id, product.quantity);
  } catch (error) {
    logger.error('[confirm] Failed to publish stock update', {
      orderId: order.id,
      error: error.message,
    });
  }
}

let running = false;

function start() {
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await confirmPendingOrders();
    } catch (error) {
      logger.error('[confirm] Scheduled job failed', { error: error.message });
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, POLL_INTERVAL_MS);
  logger.info('[confirm] SEP-0007 payment confirmation job started');
  return timer;
}

module.exports = { start, confirmPendingOrders };
