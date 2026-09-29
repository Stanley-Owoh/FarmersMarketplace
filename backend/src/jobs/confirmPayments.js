const db = require('../db/schema');
const { findIncomingPaymentsByMemo } = require('../utils/stellar');
const logger = require('../logger');

const POLL_INTERVAL_MS = 15000;

async function confirmPendingOrders() {
  const { rows: pendingOrders } = await db.query(
    `SELECT o.id, o.total_price, o.stellar_memo, p.farmer_id,
            u.stellar_public_key AS farmer_public_key
     FROM orders o
     JOIN products p ON p.id = o.product_id
     JOIN users u ON u.id = p.farmer_id
     WHERE o.status = 'pending'
       AND o.stellar_memo IS NOT NULL
       AND o.stellar_memo LIKE 'order:%'`
  );

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
      if (!txHash) continue;

      try {
        const { rowCount } = await db.query(
          `UPDATE orders
           SET status = 'paid', stellar_tx_hash = $1
           WHERE id = $2 AND status = 'pending' AND stellar_memo = $3`,
          [txHash, order.id, order.stellar_memo]
        );
        if (rowCount > 0) {
          logger.info('[confirm] SEP-0007 order payment confirmed', {
            orderId: order.id,
            txHash,
          });
        }
      } catch (error) {
        logger.error('[confirm] Failed to update paid order', {
          orderId: order.id,
          error: error.message,
        });
      }
    }
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
