const RATE_LIMIT_MAX_CHALLENGES = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

export interface RemoteWebPairingChallengeRateLimit {
  retryAfterSeconds: number;
}

const challengeCreationTimestamps: number[] = [];

export function recordRemoteWebPairingChallengeCreation(): RemoteWebPairingChallengeRateLimit | null {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  while (
    challengeCreationTimestamps.length > 0 &&
    challengeCreationTimestamps[0] <= windowStart
  ) {
    challengeCreationTimestamps.shift();
  }

  if (challengeCreationTimestamps.length >= RATE_LIMIT_MAX_CHALLENGES) {
    const resetAtMs = challengeCreationTimestamps[0] + RATE_LIMIT_WINDOW_MS;
    return {
      retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
    };
  }

  challengeCreationTimestamps.push(now);
  return null;
}

export function resetRemoteWebPairingChallengeRateLimiterForTests(): void {
  challengeCreationTimestamps.length = 0;
}
