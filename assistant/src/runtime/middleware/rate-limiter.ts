// Per-bearer-token sliding-window rate limiter for /v1/* API endpoints.
// Tracks request counts per token and returns 429 when the limit is exceeded.
// Follows the same sliding-window pattern as gateway/src/auth-rate-limiter.ts.

import type { HttpErrorResponse } from '../http-errors.js';

const DEFAULT_MAX_REQUESTS = 60;
const DEFAULT_WINDOW_MS = 60_000; // 60 seconds
const MAX_TRACKED_TOKENS = 10_000;

export class TokenRateLimiter {
  private requests = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(
    maxRequests = DEFAULT_MAX_REQUESTS,
    windowMs = DEFAULT_WINDOW_MS,
  ) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Check whether the request should be allowed and record it.
   * Returns rate limit metadata for response headers.
   */
  check(token: string): RateLimitResult {
    const now = Date.now();
    let timestamps = this.requests.get(token);

    if (!timestamps) {
      if (this.requests.size >= MAX_TRACKED_TOKENS) {
        this.evictStale(now);
        if (this.requests.size >= MAX_TRACKED_TOKENS) {
          const oldest = this.requests.keys().next().value;
          if (oldest !== undefined) this.requests.delete(oldest);
        }
      }
      timestamps = [];
      this.requests.set(token, timestamps);
    }

    const cutoff = now - this.windowMs;

    // Remove expired timestamps from the front
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    const remaining = Math.max(0, this.maxRequests - timestamps.length);
    const resetAt = timestamps.length > 0
      ? Math.ceil((timestamps[0] + this.windowMs) / 1000)
      : Math.ceil((now + this.windowMs) / 1000);

    if (timestamps.length >= this.maxRequests) {
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        resetAt,
      };
    }

    timestamps.push(now);

    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: remaining - 1,
      resetAt,
    };
  }

  private evictStale(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [token, timestamps] of this.requests) {
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.requests.delete(token);
      }
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix timestamp (seconds) when the window resets. */
  resetAt: number;
}

/** Build standard rate limit headers from a check result. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetAt),
  };
}

/** Return a 429 response with rate limit headers and a Retry-After hint. */
export function rateLimitResponse(result: RateLimitResult): Response {
  const retryAfter = Math.max(1, result.resetAt - Math.ceil(Date.now() / 1000));
  const body: HttpErrorResponse = {
    error: { code: 'RATE_LIMITED', message: 'Too Many Requests' },
  };
  return Response.json(body, {
    status: 429,
    headers: {
      ...rateLimitHeaders(result),
      'Retry-After': String(retryAfter),
    },
  });
}

/** Singleton rate limiter for the runtime HTTP API. */
export const apiRateLimiter = new TokenRateLimiter();
