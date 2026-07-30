/**
 * Simple in-memory sliding-window rate limiter keyed by IP address,
 * used by the docs search endpoint to prevent abuse.
 */

interface WindowEntry {
  count: number;
  resetAt: number;
}

const windows = new Map<string, WindowEntry>();

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 30; // per window per IP

// Periodically prune expired entries to avoid unbounded memory growth.
const PRUNE_INTERVAL_MS = 5 * 60_000;
let lastPrune = Date.now();

function pruneExpired(): void {
  const now = Date.now();
  if (now - lastPrune < PRUNE_INTERVAL_MS) {
    return;
  }

  lastPrune = now;
  for (const [key, entry] of windows) {
    if (now >= entry.resetAt) {
      windows.delete(key);
    }
  }
}

// GCP ALB appends: ..., <real-client-ip>, <lb-ip>. Use second-to-last to get the real IP.
export function resolveClientIp(forwardedFor: string | null): string {
  const parts = forwardedFor?.split(",").map((part) => part.trim()) ?? [];
  return parts.at(-2) || parts[0] || "unknown";
}

export function isRateLimited(ip: string): boolean {
  pruneExpired();

  const now = Date.now();
  const entry = windows.get(ip);

  if (!entry || now >= entry.resetAt) {
    windows.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > MAX_REQUESTS;
}
