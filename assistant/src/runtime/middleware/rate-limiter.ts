// Per-client-IP sliding-window rate limiter for /v1/* API endpoints.
// Tracks request counts per key and returns 429 when the limit is exceeded.
// Follows the same sliding-window pattern as gateway/src/auth-rate-limiter.ts.

import type { HttpErrorResponse } from "../http-errors.js";
import { getLogger } from "../../util/logger.js";
import { isPrivateAddress } from "./auth.js";

const log = getLogger("rate-limiter");

const DEFAULT_MAX_REQUESTS = 60;
const DEFAULT_WINDOW_MS = 60_000; // 60 seconds
const MAX_TRACKED_TOKENS = 10_000;

// Lower limit for unauthenticated (IP-based) requests to reduce abuse surface.
const DEFAULT_IP_MAX_REQUESTS = 20;
const DEFAULT_IP_WINDOW_MS = 60_000;
const MAX_TRACKED_IPS = 50_000;

interface RequestEntry {
  timestamp: number;
  path: string;
}

export class TokenRateLimiter {
  private requests = new Map<string, RequestEntry[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxTrackedKeys: number;

  constructor(
    maxRequests = DEFAULT_MAX_REQUESTS,
    windowMs = DEFAULT_WINDOW_MS,
    maxTrackedKeys = MAX_TRACKED_TOKENS,
  ) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.maxTrackedKeys = maxTrackedKeys;
  }

  /**
   * Check whether the request should be allowed and record it.
   * Returns rate limit metadata for response headers.
   */
  check(key: string, path?: string): RateLimitResult {
    const now = Date.now();
    let entries = this.requests.get(key);

    if (!entries) {
      if (this.requests.size >= this.maxTrackedKeys) {
        this.evictStale(now);
        if (this.requests.size >= this.maxTrackedKeys) {
          const oldest = this.requests.keys().next().value;
          if (oldest !== undefined) this.requests.delete(oldest);
        }
      }
      entries = [];
      this.requests.set(key, entries);
    }

    const cutoff = now - this.windowMs;

    // Remove expired entries from the front
    while (entries.length > 0 && entries[0].timestamp <= cutoff) {
      entries.shift();
    }

    const remaining = Math.max(0, this.maxRequests - entries.length);
    const resetAt =
      entries.length > 0
        ? Math.ceil((entries[0].timestamp + this.windowMs) / 1000)
        : Math.ceil((now + this.windowMs) / 1000);

    if (entries.length >= this.maxRequests) {
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        resetAt,
      };
    }

    entries.push({ timestamp: now, path: path ?? "unknown" });

    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: remaining - 1,
      resetAt,
    };
  }

  /**
   * Return a count of recent requests grouped by path for the given key.
   * Sorted descending by count. Useful for diagnosing which endpoints
   * are consuming the rate limit budget.
   */
  getRecentPathCounts(key: string): Array<{ path: string; count: number }> {
    const entries = this.requests.get(key);
    if (!entries || entries.length === 0) return [];

    const now = Date.now();
    const cutoff = now - this.windowMs;
    const counts = new Map<string, number>();
    for (const entry of entries) {
      if (entry.timestamp > cutoff) {
        counts.set(entry.path, (counts.get(entry.path) ?? 0) + 1);
      }
    }

    return Array.from(counts.entries())
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count);
  }

  private evictStale(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, entries] of this.requests) {
      while (entries.length > 0 && entries[0].timestamp <= cutoff) {
        entries.shift();
      }
      if (entries.length === 0) {
        this.requests.delete(key);
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
export function rateLimitHeaders(
  result: RateLimitResult,
): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.resetAt),
  };
}

/** Return a 429 response with rate limit headers and a Retry-After hint. */
export function rateLimitResponse(
  result: RateLimitResult,
  diagnostics?: {
    clientIp: string;
    deniedPath: string;
    limiterKind: "authenticated" | "unauthenticated";
    pathCounts: Array<{ path: string; count: number }>;
  },
): Response {
  const retryAfter = Math.max(1, result.resetAt - Math.ceil(Date.now() / 1000));

  if (diagnostics) {
    log.warn(
      {
        clientIp: diagnostics.clientIp,
        deniedPath: diagnostics.deniedPath,
        limiterKind: diagnostics.limiterKind,
        limit: result.limit,
        retryAfterSec: retryAfter,
        recentRequests: diagnostics.pathCounts,
      },
      `Rate limited ${diagnostics.limiterKind} request: ${diagnostics.deniedPath} (${result.limit} req/min exceeded)`,
    );
  }

  const body: HttpErrorResponse = {
    error: { code: "RATE_LIMITED", message: "Too Many Requests" },
  };
  return Response.json(body, {
    status: 429,
    headers: {
      ...rateLimitHeaders(result),
      "Retry-After": String(retryAfter),
    },
  });
}

/** Singleton rate limiter for authenticated /v1/* requests (per-client-IP). */
export const apiRateLimiter = new TokenRateLimiter();

/** Singleton rate limiter for unauthenticated requests (per-IP, lower limits). */
export const ipRateLimiter = new TokenRateLimiter(
  DEFAULT_IP_MAX_REQUESTS,
  DEFAULT_IP_WINDOW_MS,
  MAX_TRACKED_IPS,
);

/**
 * Extract the client IP from a request. Only trusts proxy headers
 * (X-Forwarded-For, X-Real-IP) when the peer IP is loopback or private,
 * meaning the request arrived via the gateway. Direct connections from
 * external clients use the peer IP, preventing header spoofing.
 */
export function extractClientIp(
  req: Request,
  server: { requestIP(req: Request): { address: string } | null },
): string {
  const peerIp = server.requestIP(req)?.address ?? "0.0.0.0";

  if (isPrivateAddress(peerIp)) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0].trim();
      if (first) return first;
    }

    const realIp = req.headers.get("x-real-ip");
    if (realIp) return realIp.trim();
  }

  return peerIp;
}
