/**
 * Checkout idempotency keys (#1379).
 *
 *   - placeOrder always sends X-Idempotency-Key and throws in dev without one
 *   - the budget-override path reuses the key it is given
 *   - useIdempotencyKey: two rapid clicks share one key, a retry after a network
 *     error / 5xx reuses it, and changing the quantity (or success) makes a new one
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { api, newIdempotencyKey } from '../api/client.js';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ok(body = {}) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(() => ok({ success: true, orderId: 1 }));
  document.cookie = 'csrf_token=test-csrf; path=/';
});

describe('api.placeOrder', () => {
  it('sends the given key as X-Idempotency-Key', async () => {
    const key = newIdempotencyKey();
    await api.placeOrder({ product_id: 1, quantity: 1 }, key);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/v1/orders');
    expect(opts.headers['X-Idempotency-Key']).toBe(key);
  });

  it('throws in dev when the key is missing', () => {
    expect(() => api.placeOrder({ product_id: 1, quantity: 1 })).toThrow(/idempotency key/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('placeOrderWithBudgetOverride reuses the original key', async () => {
    const key = newIdempotencyKey();
    await api.placeOrderWithBudgetOverride({ product_id: 1, quantity: 1 }, key);

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['X-Idempotency-Key']).toBe(key);
    expect(JSON.parse(opts.body).budget_override_confirmed).toBe(true);
  });

  it('newIdempotencyKey returns a UUID v4', () => {
    expect(newIdempotencyKey()).toMatch(UUID_V4);
  });
});

describe('useIdempotencyKey', () => {
  const inputs = { product_id: 1, quantity: 2 };

  it('gives two rapid clicks the same key', () => {
    const { result } = renderHook(() => useIdempotencyKey());
    const first = result.current.keyFor(inputs);
    const second = result.current.keyFor({ ...inputs });
    expect(first).toMatch(UUID_V4);
    expect(second).toBe(first);
  });

  it('reuses the key for a retry after a network error', () => {
    const { result } = renderHook(() => useIdempotencyKey());
    const first = result.current.keyFor(inputs);
    result.current.settle(new TypeError('Failed to fetch'));
    expect(result.current.keyFor(inputs)).toBe(first);
  });

  it('reuses the key for a retry after a 5xx', () => {
    const { result } = renderHook(() => useIdempotencyKey());
    const first = result.current.keyFor(inputs);
    result.current.settle(Object.assign(new Error('Server error'), { status: 503 }));
    expect(result.current.keyFor(inputs)).toBe(first);
  });

  it('generates a new key when the quantity changes', () => {
    const { result } = renderHook(() => useIdempotencyKey());
    const first = result.current.keyFor(inputs);
    expect(result.current.keyFor({ ...inputs, quantity: 3 })).not.toBe(first);
  });

  it('generates a new key after success', () => {
    const { result } = renderHook(() => useIdempotencyKey());
    const first = result.current.keyFor(inputs);
    result.current.settle();
    expect(result.current.keyFor(inputs)).not.toBe(first);
  });

  it('generates a new key after a definitive 4xx (the backend cached that failure)', () => {
    const { result } = renderHook(() => useIdempotencyKey());
    const first = result.current.keyFor(inputs);
    result.current.settle(Object.assign(new Error('Payment failed'), { status: 402 }));
    expect(result.current.keyFor(inputs)).not.toBe(first);
  });
});
