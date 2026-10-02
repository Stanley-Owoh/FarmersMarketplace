import { useCallback, useRef } from 'react';
import { newIdempotencyKey } from '../api/client';

/**
 * One X-Idempotency-Key per checkout attempt (#1379).
 *
 * keyFor(inputs) returns the same key for as long as the order inputs stay the
 * same, so double clicks and retries after a network error / 5xx (or a
 * budget-override confirmation) are deduplicated by the backend. A new key is
 * generated when the inputs change, or after settle(err) says the attempt is
 * finished: success, or a definitive 4xx whose response the backend has cached
 * under the old key (replaying it would only return the same failure).
 */
export function useIdempotencyKey() {
  const attempt = useRef({ key: null, fingerprint: null });

  const keyFor = useCallback((inputs) => {
    const fingerprint = JSON.stringify(inputs);
    if (!attempt.current.key || attempt.current.fingerprint !== fingerprint) {
      attempt.current = { key: newIdempotencyKey(), fingerprint };
    }
    return attempt.current.key;
  }, []);

  const reset = useCallback(() => {
    attempt.current = { key: null, fingerprint: null };
  }, []);

  // Call with no argument on success, or with the thrown error on failure.
  const settle = useCallback(
    (error) => {
      const status = error?.status;
      const retryable = error && (status == null || status >= 500);
      if (!retryable) reset();
    },
    [reset]
  );

  return { keyFor, reset, settle };
}
