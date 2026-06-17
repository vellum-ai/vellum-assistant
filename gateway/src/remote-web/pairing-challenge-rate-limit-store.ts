const RATE_LIMIT_MAX_CHALLENGES = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface RateLimitEntry {
  timestamps: number[];
}

export interface RemoteWebPairingChallengeRateLimit {
  retryAfterSeconds: number;
}

const challengeRateLimitByPublicHost = new Map<string, RateLimitEntry>();

export function recordRemoteWebPairingChallengeCreation(
  publicBaseUrl: string,
): RemoteWebPairingChallengeRateLimit | null {
  const publicHost = new URL(publicBaseUrl).hostname.toLowerCase();
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  let entry = challengeRateLimitByPublicHost.get(publicHost);
  if (!entry) {
    entry = { timestamps: [] };
    challengeRateLimitByPublicHost.set(publicHost, entry);
  }

  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
  if (entry.timestamps.length >= RATE_LIMIT_MAX_CHALLENGES) {
    const resetAtMs = entry.timestamps[0] + RATE_LIMIT_WINDOW_MS;
    return {
      retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
    };
  }

  entry.timestamps.push(now);
  return null;
}

export function resetRemoteWebPairingChallengeRateLimiterForTests(): void {
  challengeRateLimitByPublicHost.clear();
}
