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
      .mockResolvedValueOnce({ rowCount: 1 });
    findIncomingPaymentsByMemo.mockResolvedValue(new Map([['order:42', 'TX42']]));

    await confirmPendingOrders();

    expect(findIncomingPaymentsByMemo).toHaveBeenCalledWith('GFARMER', [
      { memo: 'order:42', amount: 3.5 },
    ]);
    expect(db.query).toHaveBeenLastCalledWith(
      expect.stringContaining("SET status = 'paid', stellar_tx_hash = $1"),
      ['TX42', 42, 'order:42']
    );
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
      .mockResolvedValueOnce({ rowCount: 1 });
    findIncomingPaymentsByMemo
      .mockRejectedValueOnce(new Error('Horizon unavailable'))
      .mockResolvedValueOnce(new Map([['order:2', 'TX2']]));

    await confirmPendingOrders();

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[1][1]).toEqual(['TX2', 2, 'order:2']);
  });
});
