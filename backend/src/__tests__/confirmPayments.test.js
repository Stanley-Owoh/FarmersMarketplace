jest.mock('../db/schema', () => ({ query: jest.fn() }));
jest.mock('../utils/stellar', () => ({ findIncomingPaymentsByMemo: jest.fn() }));
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../db/schema');
const { findIncomingPaymentsByMemo } = require('../utils/stellar');
const { confirmPendingOrders } = require('../jobs/confirmPayments');

describe('SEP-0007 payment confirmation job', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks only pending SEP-0007 orders paid when Horizon finds the matching memo payment', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 42,
            total_price: 3.5,
            stellar_memo: 'order:42',
            farmer_public_key: 'GFARMER',
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 10, quantity: 8, low_stock_threshold: 5, low_stock_alerted: 0 }],
      });
    findIncomingPaymentsByMemo.mockResolvedValue(new Map([['order:42', 'TX42']]));

    await confirmPendingOrders();

    expect(findIncomingPaymentsByMemo).toHaveBeenCalledWith('GFARMER', [
      { memo: 'order:42', amount: 3.5 },
    ]);
    expect(db.query.mock.calls[1]).toEqual([
      expect.stringContaining("SET status = 'paid', stellar_tx_hash = $1"),
      ['TX42', 42, 'order:42']
    ]);
  });

  it('leaves unpaid orders pending', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 43,
          total_price: 4,
          stellar_memo: 'order:43',
          farmer_public_key: 'GFARMER',
        },
      ],
    });
    findIncomingPaymentsByMemo.mockResolvedValue(new Map());

    await confirmPendingOrders();

    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('continues checking other farmers when one Horizon request fails', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [
          { id: 1, total_price: 1, stellar_memo: 'order:1', farmer_public_key: 'G1' },
          { id: 2, total_price: 2, stellar_memo: 'order:2', farmer_public_key: 'G2' },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });
    findIncomingPaymentsByMemo
      .mockRejectedValueOnce(new Error('Horizon unavailable'))
      .mockResolvedValueOnce(new Map([['order:2', 'TX2']]));

    await confirmPendingOrders();

    expect(db.query).toHaveBeenCalledTimes(3);
    expect(db.query.mock.calls[1][1]).toEqual(['TX2', 2, 'order:2']);
  });

  it('expires unpaid SEP-0007 orders after 30 minutes and releases their reserved stock', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 44,
            total_price: 4,
            stellar_memo: 'order:44',
            quantity: 3,
            product_id: 10,
            created_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
            farmer_public_key: 'GFARMER',
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });
    findIncomingPaymentsByMemo.mockResolvedValue(new Map());

    await confirmPendingOrders();

    expect(db.query.mock.calls[1]).toEqual([
      expect.stringContaining("UPDATE orders SET status = 'failed'"),
      [44, 'order:44'],
    ]);
    expect(db.query.mock.calls[2]).toEqual([
      'UPDATE products SET quantity = quantity + $1 WHERE id = $2 RETURNING quantity',
      [3, 10],
    ]);
  });
});
