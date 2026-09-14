/**
 * Idle watchdog for the extension SSE stream.
 *
 * Detects silently stalled connections where `fetch()` holds a streaming
 * connection open at the network layer with no bytes flowing and no error
 * surfaced to JavaScript (Chrome MV3 service-worker sleep, some proxies).
 * The daemon emits a heartbeat comment every ~7 s; this watchdog aborts
 * the active fetch when no SSE traffic (events OR heartbeat comments)
 * arrives within a configurable window.
 */

/** Milliseconds of silence before the watchdog fires. */
export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 45_000;

export type IdleWatchdogAbortCause = "watchdog";

export interface IdleWatchdogFireInfo {
  /** Reconnect-attempt counter supplied to {@link IdleWatchdog.arm}. */
  attempt: number;
  idleTimeoutMs: number;
  /**
   * Age of the most recent recorded SSE frame, or `null` when the
   * attempt never received any traffic.
   */
  lastByteAgeMs: number | null;
  keepalivesReceivedSinceConnect: number;
  dataFramesReceivedSinceConnect: number;
}

export interface IdleWatchdogConfig {
  /** Milliseconds of silence before the watchdog fires. */
  idleTimeoutMs?: number;
  /**
   * Invoked immediately before the AbortController is aborted.
   * Must not throw; the core swallows errors so telemetry cannot
   * block recovery.
   */
  onFire?: (info: IdleWatchdogFireInfo) => void;
}

export interface IdleWatchdog {
  /**
   * Reset (or arm) the idle timer for the given controller. Called
   * immediately before the read loop and on every parsed SSE chunk,
   * including heartbeat comments. If no traffic arrives within
   * `idleTimeoutMs`, the controller is aborted.
   */
  arm(controller: AbortController, attempt: number): void;
  /** Cancel any pending timer. */
  clear(): void;
  /** Reset per-attempt liveness counters (call on each new connect). */
  resetCounters(): void;
  /**
   * Record an SSE traffic event. `isData` distinguishes data frames
   * from heartbeat comment frames.
   */
  recordTraffic(isData: boolean): void;
  /**
   * Return and clear the cause set by the most recent watchdog fire.
   * Returns `null` if the watchdog has not fired since the last
   * consume (or ever).
   */
  consumeLastAbortCause(): IdleWatchdogAbortCause | null;
}

/**
 * Create a watchdog instance that monitors SSE stream liveness.
 *
 * The returned handle encapsulates the timer and liveness counters.
 * Callers arm it on every SSE chunk and clear it when the read loop
 * exits. Optional {@link IdleWatchdogConfig.onFire} is the hook for
 * logging.
 */
export function createIdleWatchdog(
  config: IdleWatchdogConfig = {},
): IdleWatchdog {
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_SSE_IDLE_TIMEOUT_MS;
  const { onFire } = config;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSseAtMs: number | null = null;
  let keepalivesReceivedSinceConnect = 0;
  let dataFramesReceivedSinceConnect = 0;
  let lastAbortCause: IdleWatchdogAbortCause | null = null;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = (controller: AbortController, attempt: number) => {
    clear();
    timer = setTimeout(() => {
      timer = null;
      lastAbortCause = "watchdog";

      const lastByteAgeMs =
        lastSseAtMs === null ? null : Date.now() - lastSseAtMs;

      if (onFire) {
        try {
          onFire({
            attempt,
            idleTimeoutMs,
            lastByteAgeMs,
            keepalivesReceivedSinceConnect,
            dataFramesReceivedSinceConnect,
          });
        } catch {
          // Diagnostics are best-effort and must never block recovery.
        }
      }

      controller.abort();
    }, idleTimeoutMs);
  };

  const resetCounters = () => {
    lastSseAtMs = null;
    keepalivesReceivedSinceConnect = 0;
    dataFramesReceivedSinceConnect = 0;
  };

  const recordTraffic = (isData: boolean) => {
    if (isData) {
      dataFramesReceivedSinceConnect++;
    } else {
      keepalivesReceivedSinceConnect++;
    }
    lastSseAtMs = Date.now();
  };

  const consumeLastAbortCause = (): IdleWatchdogAbortCause | null => {
    const cause = lastAbortCause;
    lastAbortCause = null;
    return cause;
  };

  return { arm, clear, resetCounters, recordTraffic, consumeLastAbortCause };
}
