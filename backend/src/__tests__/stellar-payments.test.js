const mockPaymentOp = jest.fn((value) => value);
const mockSubmitTransaction = jest.fn().mockResolvedValue({ hash: 'tx-hash' });
const mockPaymentsCall = jest.fn();
const mockTransactionCall = jest.fn();
const mockPaymentsEndpoint = {
  forAccount: jest.fn(() => mockPaymentsEndpoint),
  order: jest.fn(() => mockPaymentsEndpoint),
  limit: jest.fn(() => mockPaymentsEndpoint),
  call: mockPaymentsCall,
};
const mockBuilder = {
  addOperation: jest.fn(() => mockBuilder), addMemo: jest.fn(() => mockBuilder),
  setTimeout: jest.fn(() => mockBuilder), build: jest.fn(() => ({ sign: jest.fn() })),
};
jest.mock('../config', () => ({
  platformFeePercent: 2.5, platformWalletPublicKey: 'GPLATFORM',
  platformFeeAccountSecret: null, feeBumpThresholdXlm: 1,
}));
jest.mock('../utils/stellar-accounts', () => ({ getBalance: jest.fn().mockResolvedValue(10) }));
jest.mock('../utils/stellar-config', () => ({
  StellarSdk: {
    BASE_FEE: '100', Asset: Object.assign(jest.fn(), { native: jest.fn(() => 'XLM') }),
    Keypair: { fromSecret: jest.fn(() => ({ publicKey: () => 'GSENDER' })) },
    Memo: { text: jest.fn((text) => text) }, Operation: { pathPaymentStrictReceive: mockPaymentOp },
    TransactionBuilder: jest.fn(() => mockBuilder),
  },
  server: {
    loadAccount: jest.fn().mockResolvedValue({}),
    submitTransaction: mockSubmitTransaction,
    payments: jest.fn(() => mockPaymentsEndpoint),
    transactions: jest.fn(() => ({
      transaction: jest.fn((hash) => ({
        call: () => mockTransactionCall(hash),
      })),
    })),
  },
  networkPassphrase: 'test', isTestnet: true,
}));

const payments = require('../utils/stellar-payments');
const stellarConfig = require('../utils/stellar-config');

describe('stellar payments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stellarConfig.StellarSdk.Keypair.fromSecret.mockReturnValue({
      publicKey: () => 'GSENDER',
    });
    stellarConfig.StellarSdk.TransactionBuilder.mockImplementation(() => mockBuilder);
    stellarConfig.StellarSdk.Operation.pathPaymentStrictReceive.mockImplementation((value) => value);
    stellarConfig.server.loadAccount.mockResolvedValue({});
    stellarConfig.server.submitTransaction.mockResolvedValue({ hash: 'tx-hash' });
    stellarConfig.server.payments.mockReturnValue(mockPaymentsEndpoint);
    stellarConfig.server.transactions.mockImplementation(() => ({
      transaction: jest.fn((hash) => ({
        call: () => mockTransactionCall(hash),
      })),
    }));
    mockPaymentsEndpoint.forAccount.mockImplementation(() => mockPaymentsEndpoint);
    mockPaymentsEndpoint.order.mockImplementation(() => mockPaymentsEndpoint);
    mockPaymentsEndpoint.limit.mockImplementation(() => mockPaymentsEndpoint);
    mockBuilder.addOperation.mockReturnValue(mockBuilder);
    mockBuilder.addMemo.mockReturnValue(mockBuilder);
    mockBuilder.setTimeout.mockReturnValue(mockBuilder);
    mockBuilder.build.mockReturnValue({ sign: jest.fn() });
  });

  test.each([[0, 0, 0], [0.0000001, 0, 0.0000001], [10, 0.25, 9.75]])(
    'fee split for %p XLM', (amount, fee, farmer) => {
      expect(payments.getPlatformFeeInfo(amount)).toMatchObject({ feeAmount: fee, farmerAmount: farmer });
    },
  );

  it('formats path-payment send_max to seven decimals', async () => {
    expect(payments.getPathPaymentSendMax(100, 0.5)).toBe(100.5);
    expect(payments.getPathPaymentSendMax(0, 5)).toBe(0);
    await payments.pathPayment({ senderSecret: 'S', sourceAssetCode: 'XLM',
      sendMax: 1.005, receiverPublicKey: 'GDEST', destAmount: 1 });
    expect(mockPaymentOp).toHaveBeenCalledWith(expect.objectContaining({ sendMax: '1.0050000' }));
    expect(mockSubmitTransaction).toHaveBeenCalled();
  });

  it('matches native-XLM payments by destination, amount, and exact text memo', async () => {
    mockPaymentsCall.mockResolvedValue({
      records: [
        {
          type: 'payment',
          asset_type: 'native',
          to: 'GFARMER',
          amount: '3.5000000',
          transaction_hash: 'tx-good',
        },
        {
          type: 'payment',
          asset_type: 'native',
          to: 'GFARMER',
          amount: '3.5000000',
          transaction_hash: 'tx-wrong-memo',
        },
        {
          type: 'payment',
          asset_type: 'credit_alphanum4',
          to: 'GFARMER',
          amount: '3.5000000',
          transaction_hash: 'tx-wrong-asset',
        },
      ],
    });
    mockTransactionCall.mockImplementation(async (hash) => ({
      successful: true,
      memo_type: 'text',
      memo: hash === 'tx-good' ? 'order:42' : 'order:other',
    }));

    const found = await payments.findIncomingPaymentsByMemo('GFARMER', [
      { memo: 'order:42', amount: 3.5 },
    ]);

    expect(found).toEqual(new Map([['order:42', 'tx-good']]));
    expect(mockPaymentsEndpoint.forAccount).toHaveBeenCalledWith('GFARMER');
    expect(mockTransactionCall).toHaveBeenCalledTimes(2);
  });
});
