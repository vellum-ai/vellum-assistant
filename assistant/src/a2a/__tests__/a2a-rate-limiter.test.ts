import { describe, expect, test } from 'bun:test';

import { A2ARateLimiter, a2aRateLimitResponse, a2aRateLimitHeaders } from '../a2a-rate-limiter.js';

describe('A2ARateLimiter', () => {
  test('allows requests within the limit', () => {
    const limiter = new A2ARateLimiter({ maxAttempts: 3, windowMs: 60_000 });

    const r1 = limiter.check('key-1');
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.check('key-1');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = limiter.check('key-1');
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  test('blocks requests after limit is reached', () => {
    const limiter = new A2ARateLimiter({ maxAttempts: 2, windowMs: 60_000 });

    limiter.check('key-1');
    limiter.check('key-1');

    const result = limiter.check('key-1');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test('separate keys are tracked independently', () => {
    const limiter = new A2ARateLimiter({ maxAttempts: 1, windowMs: 60_000 });

    const r1 = limiter.check('key-a');
    expect(r1.allowed).toBe(true);

    const r2 = limiter.check('key-b');
    expect(r2.allowed).toBe(true);

    const r3 = limiter.check('key-a');
    expect(r3.allowed).toBe(false);
  });

  test('clear resets all state', () => {
    const limiter = new A2ARateLimiter({ maxAttempts: 1, windowMs: 60_000 });

    limiter.check('key-1');
    const blocked = limiter.check('key-1');
    expect(blocked.allowed).toBe(false);

    limiter.clear();

    const afterClear = limiter.check('key-1');
    expect(afterClear.allowed).toBe(true);
  });

  test('resetAt is a valid Unix timestamp in seconds', () => {
    const limiter = new A2ARateLimiter({ maxAttempts: 5, windowMs: 60_000 });
    const result = limiter.check('key-1');
    expect(result.resetAt).toBeGreaterThan(Date.now() / 1000 - 10);
    expect(result.resetAt).toBeLessThan(Date.now() / 1000 + 120);
  });

  test('evicts stale entries when maxTrackedKeys is reached', () => {
    const limiter = new A2ARateLimiter({
      maxAttempts: 10,
      windowMs: 1, // 1ms window — all entries expire instantly
      maxTrackedKeys: 2,
    });

    limiter.check('key-a');
    limiter.check('key-b');

    // Small delay to let the 1ms window expire
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait
    }

    // This should trigger eviction of stale keys
    const result = limiter.check('key-c');
    expect(result.allowed).toBe(true);
  });
});

describe('a2aRateLimitHeaders', () => {
  test('returns correct header keys', () => {
    const headers = a2aRateLimitHeaders({
      allowed: true,
      limit: 5,
      remaining: 3,
      resetAt: 1234567890,
    });
    expect(headers['X-RateLimit-Limit']).toBe('5');
    expect(headers['X-RateLimit-Remaining']).toBe('3');
    expect(headers['X-RateLimit-Reset']).toBe('1234567890');
  });
});

describe('a2aRateLimitResponse', () => {
  test('returns 429 with Retry-After header', async () => {
    const result = {
      allowed: false,
      limit: 5,
      remaining: 0,
      resetAt: Math.ceil(Date.now() / 1000) + 60,
    };
    const response = a2aRateLimitResponse(result);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBeTruthy();
    expect(response.headers.get('X-RateLimit-Limit')).toBe('5');

    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });
});
