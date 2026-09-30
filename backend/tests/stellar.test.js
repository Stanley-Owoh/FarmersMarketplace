const mockSubmitTransaction = jest.fn();
const mockLoadAccount = jest.fn();
const mockPaymentsCall = jest.fn();
const mockPaymentsBuilder = {
  forAccount: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  call: mockPaymentsCall,
};
const mockServerInstance = {
  loadAccount: mockLoadAccount,
  payments: jest.fn(() => mockPaymentsBuilder),
  submitTransaction: mockSubmitTransaction,
};
const mockBuilt = { sign: jest.fn() };

let StellarSdk;
let stellar;

jest.unmock('../src/utils/stellar');

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockSubmitTransaction.mockReset();
  mockLoadAccount.mockReset();
  mockPaymentsCall.mockReset();
  mockPaymentsBuilder.forAccount.mockReset();
  mockPaymentsBuilder.order.mockReset();
  mockPaymentsBuilder.limit.mockReset();
  mockPaymentsBuilder.forAccount.mockReturnThis();
  mockPaymentsBuilder.order.mockReturnThis();
  mockPaymentsBuilder.limit.mockReturnThis();
  mockServerInstance.payments.mockReturnValue(mockPaymentsBuilder);
  mockBuilt.sign.mockClear();

  jest.doMock('@stellar/stellar-sdk', () => {
    const mockTxBuilder = {
      addOperation: jest.fn(function () { return this; }),
      addMemo: jest.fn(function () { return this; }),
      setTimeout: jest.fn(function () { return this; }),
      build: jest.fn(() => mockBuilt),
    };

    return {
      Horizon: {
        Server: jest.fn(() => mockServerInstance),
      },
      Networks: {
        TESTNET: 'Test SDF Network ; September 2015',
        PUBLIC: 'Public Global Stellar Network ; September 2015',
      },
      SorobanRpc: {
        Server: jest.fn(() => ({})),
      },
      Keypair: {
        random: jest.fn(),
        fromSecret: jest.fn(),
      },
      TransactionBuilder: jest.fn(() => mockTxBuilder),
      Operation: {
        payment: jest.fn(() => 'mock-payment-op'),
      },
      Asset: {
        native: jest.fn(() => 'native-asset'),
      },
      Memo: {
        text: jest.fn((t) => `memo:${t}`),
      },
      StrKey: {
        isValidEd25519PublicKey: jest.fn((key) => typeof key === 'string' && /^G[A-Z2-7]{55}$/.test(key)),
      },
      BASE_FEE: '100',
    };
  });

  jest.doMock('stellar-hd-wallet', () => ({
    fromMnemonic: jest.fn(() => ({
      getSecret: jest.fn(() => 'SSEED_TESTNET_MOCK'),
    })),
  }));

  jest.doMock('../src/utils/stellar-config', () => ({
    StellarSdk: jest.requireMock('@stellar/stellar-sdk'),
    STELLAR_NETWORK: 'testnet',
    isTestnet: true,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    server: mockServerInstance,
    sorobanServer: {},
  }));

  process.env.STELLAR_NETWORK = 'testnet';
  StellarSdk = require('@stellar/stellar-sdk');
  stellar = require('../src/utils/stellar');
});

describe('createWallet()', () => {
  it('returns an object with publicKey and secretKey', () => {
    StellarSdk.Keypair.random.mockReturnValue({
      publicKey: () => 'GPUBLIC_KEY_MOCK',
      secret: () => 'SSECRET_KEY_MOCK',
    });

    const wallet = stellar.createWallet();

    expect(wallet).toEqual({
      publicKey: 'GPUBLIC_KEY_MOCK',
      secretKey: 'SSECRET_KEY_MOCK',
    });
  });

  it('calls Keypair.random() each time', () => {
    StellarSdk.Keypair.random
      .mockReturnValueOnce({ publicKey: () => 'GPUB1', secret: () => 'SSEC1' })
      .mockReturnValueOnce({ publicKey: () => 'GPUB2', secret: () => 'SSEC2' });

    const w1 = stellar.createWallet();
    const w2 = stellar.createWallet();

    expect(w1.publicKey).toBe('GPUB1');
    expect(w2.publicKey).toBe('GPUB2');
    expect(StellarSdk.Keypair.random).toHaveBeenCalledTimes(2);
  });
});

describe('getBalance()', () => {
  it('returns the native XLM balance for a funded account', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [
        { asset_type: 'credit_alphanum4', balance: '50.0000000' },
        { asset_type: 'native', balance: '123.4567890' },
      ],
    });

    const balance = await stellar.getBalance('GPUB');
    expect(balance).toBe(123.456789);
    expect(mockLoadAccount).toHaveBeenCalledWith('GPUB');
  });

  it('returns 0 when the account has no native balance entry', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [{ asset_type: 'credit_alphanum4', balance: '10.0000000' }],
    });

    const balance = await stellar.getBalance('GPUB');
    expect(balance).toBe(0);
  });

  it('returns 0 for an unfunded (non-existent) account', async () => {
    mockLoadAccount.mockRejectedValue(new Error('Account not found'));

    const balance = await stellar.getBalance('GNEW');
    expect(balance).toBe(0);
  });
});

describe('sendPayment()', () => {
  const params = {
    senderSecret: 'SSENDER_SECRET',
    receiverPublicKey: 'GRECEIVER',
    amount: 10.5,
    memo: 'order-42',
  };

  beforeEach(() => {
    StellarSdk.Keypair.fromSecret.mockReturnValue({
      publicKey: () => 'GSENDER',
      secret: () => 'SSECRET',
    });
    mockLoadAccount.mockResolvedValue({ id: 'GSENDER' });
    mockSubmitTransaction.mockResolvedValue({ hash: 'TXHASH_ABC' });
    mockBuilt.sign.mockClear();
  });

  it('returns the transaction hash on success', async () => {
    const hash = await stellar.sendPayment(params);
    expect(hash).toBe('TXHASH_ABC');
  });

  it('calls submitTransaction with the built & signed transaction', async () => {
    await stellar.sendPayment(params);

    expect(mockBuilt.sign).toHaveBeenCalled();
    expect(mockSubmitTransaction).toHaveBeenCalledWith(mockBuilt);
  });

  it('builds a payment operation with correct destination and amount', async () => {
    await stellar.sendPayment(params);

    expect(StellarSdk.Operation.payment).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: 'GRECEIVER',
        amount: '10.5000000',
        asset: 'native-asset',
      })
    );
  });

  it('attaches the memo to the transaction', async () => {
    await stellar.sendPayment(params);
    expect(StellarSdk.Memo.text).toHaveBeenCalledWith('order-42');
  });

  it('uses default memo "FarmersMarket" when none provided', async () => {
    await stellar.sendPayment({ ...params, memo: undefined });
    expect(StellarSdk.Memo.text).toHaveBeenCalledWith('FarmersMarket');
  });

  it('loads the sender account before building the transaction', async () => {
    await stellar.sendPayment(params);
    expect(mockLoadAccount).toHaveBeenCalledWith('GSENDER');
  });

  it('propagates errors thrown by submitTransaction', async () => {
    mockSubmitTransaction.mockRejectedValue(new Error('op_no_destination'));
    await expect(stellar.sendPayment(params)).rejects.toThrow('op_no_destination');
  });
});

describe('getTransactions()', () => {
  const PUBLIC_KEY = 'GPUBLIC';

  const makeRecord = (overrides = {}) => ({
    id: 'rec1',
    type: 'payment',
    asset_type: 'native',
    from: 'GSENDER',
    to: PUBLIC_KEY,
    amount: '5.0000000',
    created_at: '2024-01-01T00:00:00Z',
    transaction_hash: 'TXHASH',
    ...overrides,
  });

  it('returns mapped payment records for the account', async () => {
    mockPaymentsCall.mockResolvedValue({
      records: [makeRecord({ to: PUBLIC_KEY, from: 'GSENDER' })],
    });

    const { records } = await stellar.getTransactions(PUBLIC_KEY);

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      id: 'rec1',
      type: 'received',
      amount: '5.0000000',
      from: 'GSENDER',
      to: PUBLIC_KEY,
      created_at: '2024-01-01T00:00:00Z',
      transaction_hash: 'TXHASH',
    });
  });

  it('marks outgoing payments as "sent"', async () => {
    mockPaymentsCall.mockResolvedValue({
      records: [makeRecord({ from: PUBLIC_KEY, to: 'GRECEIVER' })],
    });

    const { records } = await stellar.getTransactions(PUBLIC_KEY);
    expect(records[0].type).toBe('sent');
  });

  it('filters out non-payment records', async () => {
    mockPaymentsCall.mockResolvedValue({
      records: [
        makeRecord(),
        makeRecord({ id: 'rec2', type: 'create_account' }),
        makeRecord({ id: 'rec3', type: 'path_payment_strict_receive' }),
      ],
    });

    const { records } = await stellar.getTransactions(PUBLIC_KEY);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('rec1');
  });

  it('filters out non-native asset payments', async () => {
    mockPaymentsCall.mockResolvedValue({
      records: [makeRecord(), makeRecord({ id: 'rec2', asset_type: 'credit_alphanum4' })],
    });

    const { records } = await stellar.getTransactions(PUBLIC_KEY);
    expect(records).toHaveLength(1);
  });

  it('returns an empty array when the account has no transactions', async () => {
    mockPaymentsCall.mockResolvedValue({ records: [] });

    const result = await stellar.getTransactions(PUBLIC_KEY);
    expect(result.records).toEqual([]);
  });

  it('returns an empty array when the Horizon call throws', async () => {
    mockPaymentsCall.mockRejectedValue(new Error('Network error'));

    const result = await stellar.getTransactions(PUBLIC_KEY);
    expect(result.records).toEqual([]);
  });

  it('queries payments in descending order with limit 20', async () => {
    mockPaymentsCall.mockResolvedValue({ records: [] });

    await stellar.getTransactions(PUBLIC_KEY);

    expect(mockPaymentsBuilder.forAccount).toHaveBeenCalledWith(PUBLIC_KEY);
    expect(mockPaymentsBuilder.order).toHaveBeenCalledWith('desc');
    expect(mockPaymentsBuilder.limit).toHaveBeenCalledWith(20);
  });
});

describe("generatePaymentLink()", () => {
  const validDestination = 'GAXH3JK46JNAE6LHCXCUDEKVLFZSCVWJITMDZB37TXXQI5Z55CGAVGHN';

  beforeAll(() => {
    process.env.STELLAR_NETWORK = 'testnet';
  });

  it('generates testnet stellar:pay URI with required params', () => {
    const link = stellar.generatePaymentLink({
      destination: validDestination,
      amount: 10.5,
      memo: 'Order #123',
      assetCode: 'XLM',
      assetIssuer: 'GISSUER',
    });
    expect(link).toBe(
      'web+stellar:pay?destination=' + validDestination +
        '&amount=10.5&asset_code=XLM&asset_issuer=GISSUER&memo=Order+%23123&memo_type=text'
    );
  });

  it('uses the web+stellar scheme on all networks', () => {
    process.env.STELLAR_NETWORK = 'mainnet';
    const link = stellar.generatePaymentLink({
      destination: validDestination,
      amount: 5,
      assetCode: 'XLM',
      assetIssuer: 'GISSUER',
    });
    expect(link).toBe(
      'web+stellar:pay?destination=' + validDestination +
        '&amount=5&asset_code=XLM&asset_issuer=GISSUER'
    );
  });

  it('uses provided asset details when constructing the payment link', () => {
    process.env.STELLAR_NETWORK = 'testnet';
    const link = stellar.generatePaymentLink({
      destination: validDestination,
      amount: 1.23,
      assetCode: 'USD',
      assetIssuer: 'GISSUER',
    });
    expect(link).toBe(
      'web+stellar:pay?destination=' + validDestination +
        '&amount=1.23&asset_code=USD&asset_issuer=GISSUER'
    );
  });
});
