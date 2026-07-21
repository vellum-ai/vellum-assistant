/**
 * Per-IP request rate limiter for the public QR pairing exchange route.
 *
 * The exchange endpoint is internet-facing, so it is capped per client IP as
 * defence-in-depth against request floods. It counts every attempt (not only
 * failures) so it never distinguishes a valid code from an invalid one via its
 * rate-limit behaviour — the code's 256-bit entropy is what makes guessing
 * infeasible; this bound just protects the endpoint from abuse.
 *
 * Note: the self-hosted nginx edge does not forward a client IP (it strips
 * `X-Forwarded-For`, which the loopback guards reject), so edge-tunnelled
 * callers share the loopback peer IP and this acts as a global bound for
 * tunnelled traffic. That is acceptable for a single-user self-hosted assistant
 * whose legitimate pairing volume is tiny.
 */

const RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface RateLimitEntry {
  timestamps: number[];
}

export interface QrPairingExchangeRateLimit {
  retryAfterSeconds: number;
}

const requestsByIp = new Map<string, RateLimitEntry>();

/**
 * Record an exchange attempt for `clientIp` and return a retry hint when the
 * per-IP window is already full, or null when the attempt is within budget.
 */
export function checkQrPairingExchangeRateLimit(
  clientIp: string,
): QrPairingExchangeRateLimit | null {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  let entry = requestsByIp.get(clientIp);
  if (!entry) {
    entry = { timestamps: [] };
    requestsByIp.set(clientIp, entry);
  }
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  if (entry.timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    const resetAtMs = entry.timestamps[0] + RATE_LIMIT_WINDOW_MS;
    return {
      retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
    };
  }

  entry.timestamps.push(now);
  return null;
}

export function resetQrPairingExchangeRateLimiterForTests(): void {
  requestsByIp.clear();
}
