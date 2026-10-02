const stockClients = new Map();

function broadcastStockUpdate(productId, quantity) {
  const clients = stockClients.get(String(productId));
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify({ quantity })}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      // Disconnected clients are removed when their request closes.
    }
  }
}

module.exports = { stockClients, broadcastStockUpdate };
