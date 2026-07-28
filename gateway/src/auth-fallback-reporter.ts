// Periodically drains AuthFallbackCountTracker and ships the accumulated counts
// to the daemon's internal telemetry route, which persists them and forwards
// them to the platform. Best-effort background work: failures are logged and the
// drained counts are merged back so a transient daemon blip doesn't lose a
// window. Deliberately does NOT touch the runtime circuit breaker — this is
// non-critical traffic and must never affect chat routing.

import type {
  AuthFallbackCount,
  AuthFallbackCountTracker,
} from "./auth-fallback-count-tracker.js";
import type { fetchImpl } from "./fetch.js";
import { postInternalTelemetry } from "./internal-telemetry-client.js";
import { getLogger } from "./logger.js";

const log = getLogger("auth-fallback-reporter");

const ROUTE_PATH = "/v1/internal/telemetry/auth-fallback";
const DEFAULT_FLUSH_INTERVAL_MS = 60_000;

function getFlushIntervalMs(): number {
  const raw = process.env.AUTH_FALLBACK_FLUSH_INTERVAL_MS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_FLUSH_INTERVAL_MS;
}

export type AuthFallbackReporterConfig = {
  tracker: AuthFallbackCountTracker;
  /** Daemon runtime base URL (`config.assistantRuntimeBaseUrl`). */
  baseUrl: string;
  /** Flush cadence; defaults to AUTH_FALLBACK_FLUSH_INTERVAL_MS or 60s. */
  intervalMs?: number;
  /** Injectable for tests. Defaults to the shared fetch wrapper. */
  fetchImpl?: typeof fetchImpl;
  /** Injectable for tests. Defaults to minting a real service token. */
  mintToken?: () => string;
};

/** Shape the daemon route expects (`failure_kind` is snake_case on the wire). */
type WireCount = {
  guard: string;
  path: string;
  failure_kind: string;
  count: number;
};

export class AuthFallbackReporter {
  private readonly tracker: AuthFallbackCountTracker;
  private readonly baseUrl: string;
  private readonly intervalMs: number;
  private readonly doFetch: typeof fetchImpl | undefined;
  private readonly mintToken: (() => string) | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AuthFallbackReporterConfig) {
    this.tracker = config.tracker;
    this.baseUrl = config.baseUrl;
    this.intervalMs = config.intervalMs ?? getFlushIntervalMs();
    this.doFetch = config.fetchImpl;
    this.mintToken = config.mintToken;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.intervalMs);
    log.info({ intervalMs: this.intervalMs }, "Auth-fallback reporter started");
  }

  /** Stop the timer and flush whatever is buffered one last time. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /**
   * Drain the tracker and POST the counts to the daemon. On any failure the
   * drained counts are merged back so they retry on the next flush.
   */
  async flush(): Promise<void> {
    const batch = this.tracker.drain();
    if (batch.counts.length === 0) return;

    const body = {
      window_start: batch.windowStart,
      window_end: batch.windowEnd,
      counts: batch.counts.map(
        (c: AuthFallbackCount): WireCount => ({
          guard: c.guard,
          path: c.path,
          failure_kind: c.failureKind,
          count: c.count,
        }),
      ),
    };

    try {
      const resp = await postInternalTelemetry({
        baseUrl: this.baseUrl,
        path: ROUTE_PATH,
        body,
        fetchImpl: this.doFetch,
        mintToken: this.mintToken,
      });
      if (!resp.ok) {
        log.warn(
          { status: resp.status, keys: batch.counts.length },
          "Auth-fallback flush rejected — re-queueing counts for next flush",
        );
        this.tracker.merge(batch.counts);
      }
    } catch (err) {
      log.warn(
        { err, keys: batch.counts.length },
        "Auth-fallback flush failed — re-queueing counts for next flush",
      );
      this.tracker.merge(batch.counts);
    }
  }
}
