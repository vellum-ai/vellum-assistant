/**
 * In-memory rate limiter for A2A handshake endpoints.
 *
 * Uses a sliding-window approach keyed by a string identifier (token, session
 * ID, IP, etc.). Each limiter instance tracks attempts per key and rejects
 * requests once the cap is hit within the window.
 *
 * All limiters are independent — instantiate one per concern (invite
 * redemption, code verification, status polling, connect requests).
 */

import { getLogger } from '../util/logger.js';

const log = getLogger('a2a-rate-limiter');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface A2ARateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix timestamp (seconds) when the current window resets. */
  resetAt: number;
}

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

export class A2ARateLimiter {
  private readonly requests = new Map<string, number[]>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly maxTrackedKeys: number;
  private readonly label: string;

  constructor(opts: {
    maxAttempts: number;
    windowMs: number;
    maxTrackedKeys?: number;
    /** Human-readable label for log messages. */
    label?: string;
  }) {
    this.maxAttempts = opts.maxAttempts;
    this.windowMs = opts.windowMs;
    this.maxTrackedKeys = opts.maxTrackedKeys ?? 10_000;
    this.label = opts.label ?? 'a2a';
  }

  /**
   * Check whether a request for `key` should be allowed.
   * Records the attempt and returns rate-limit metadata.
   */
  check(key: string): A2ARateLimitResult {
    const now = Date.now();
    let timestamps = this.requests.get(key);

    if (!timestamps) {
      if (this.requests.size >= this.maxTrackedKeys) {
        this.evictStale(now);
        if (this.requests.size >= this.maxTrackedKeys) {
          const oldest = this.requests.keys().next().value;
          if (oldest !== undefined) this.requests.delete(oldest);
        }
      }
      timestamps = [];
      this.requests.set(key, timestamps);
    }

    const cutoff = now - this.windowMs;

    // Remove expired timestamps from the front
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    const remaining = Math.max(0, this.maxAttempts - timestamps.length);
    const resetAt = timestamps.length > 0
      ? Math.ceil((timestamps[0] + this.windowMs) / 1000)
      : Math.ceil((now + this.windowMs) / 1000);

    if (timestamps.length >= this.maxAttempts) {
      log.warn({ key: key.slice(0, 8) + '...', label: this.label }, 'Rate limit exceeded');
      return {
        allowed: false,
        limit: this.maxAttempts,
        remaining: 0,
        resetAt,
      };
    }

    timestamps.push(now);

    return {
      allowed: true,
      limit: this.maxAttempts,
      remaining: remaining - 1,
      resetAt,
    };
  }

  /** Evict entries whose timestamps have all expired. */
  private evictStale(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.requests) {
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.requests.delete(key);
      }
    }
  }

  /** Reset all tracked state (for testing). */
  clear(): void {
    this.requests.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton instances
// ---------------------------------------------------------------------------

/** Invite redemption: max 5 attempts per invite token per 15-minute window. */
export const inviteRedemptionLimiter = new A2ARateLimiter({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  label: 'invite-redemption',
});

/** Code verification: max 5 attempts per handshake session per 15-minute window. */
export const codeVerificationLimiter = new A2ARateLimiter({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  label: 'code-verification',
});

/** Status polling: max 60 requests/minute per handshake ID. */
export const statusPollingLimiter = new A2ARateLimiter({
  maxAttempts: 60,
  windowMs: 60 * 1000,
  label: 'status-polling',
});

/** Connect requests: max 10 inbound requests per source IP per minute. */
export const connectRequestLimiter = new A2ARateLimiter({
  maxAttempts: 10,
  windowMs: 60 * 1000,
  label: 'connect-request',
});

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Build standard rate limit headers from a check result. */
export function a2aRateLimitHeaders(result: A2ARateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetAt),
  };
}

/** Return a 429 response with rate limit headers and a Retry-After hint. */
export function a2aRateLimitResponse(result: A2ARateLimitResult): Response {
  const retryAfter = Math.max(1, result.resetAt - Math.ceil(Date.now() / 1000));
  return Response.json(
    { error: { code: 'RATE_LIMITED', message: 'Too Many Requests' } },
    {
      status: 429,
      headers: {
        ...a2aRateLimitHeaders(result),
        'Retry-After': String(retryAfter),
      },
    },
  );
}
