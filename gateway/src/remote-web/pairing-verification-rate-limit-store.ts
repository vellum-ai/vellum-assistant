const RATE_LIMIT_MAX_FAILURES = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface RateLimitEntry {
  timestamps: number[];
}

export interface RemoteWebPairingVerificationRateLimit {
  retryAfterSeconds: number;
}

const failureRateLimitByIp = new Map<string, RateLimitEntry>();

export function checkRemoteWebPairingVerificationRateLimit(
  clientIp: string,
): RemoteWebPairingVerificationRateLimit | null {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const entry = failureRateLimitByIp.get(clientIp);
  if (!entry) return null;

  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
  if (entry.timestamps.length === 0) {
    failureRateLimitByIp.delete(clientIp);
    return null;
  }
  if (entry.timestamps.length < RATE_LIMIT_MAX_FAILURES) return null;

  const resetAtMs = entry.timestamps[0] + RATE_LIMIT_WINDOW_MS;
  return {
    retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
  };
}

export function recordRemoteWebPairingVerificationFailure(
  clientIp: string,
): void {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  let entry = failureRateLimitByIp.get(clientIp);
  if (!entry) {
    entry = { timestamps: [] };
    failureRateLimitByIp.set(clientIp, entry);
  }
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
  entry.timestamps.push(now);
}

export function clearRemoteWebPairingVerificationFailures(
  clientIp: string,
): void {
  failureRateLimitByIp.delete(clientIp);
}

export function resetRemoteWebPairingVerificationRateLimiterForTests(): void {
  failureRateLimitByIp.clear();
}
