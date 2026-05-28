import { getLogger } from "../util/logger.js";
import type { ToolExecutionResult } from "./types.js";

const log = getLogger("tool-execution-timeout");

const TIMEOUT_SENTINEL = Symbol("tool-timeout");

const DEFAULT_TOOL_TIMEOUT_SEC = 120;

/**
 * Interval at which the watchdog checks whether a tool execution has
 * exceeded its timeout. Acts as a backup: if the primary `setTimeout`
 * callback is delayed (event-loop blockage, GC pause, etc.), the
 * watchdog force-resolves the timeout promise on its next tick.
 */
const WATCHDOG_INTERVAL_MS = 30_000;

/**
 * Convert a config-provided seconds value to a safe milliseconds value,
 * falling back to the default if the input is NaN, non-finite, zero, or negative.
 */
export function safeTimeoutMs(sec: unknown): number {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_TOOL_TIMEOUT_SEC * 1000;
  }
  return n * 1000;
}

/**
 * Race a tool execution promise against a timeout. Returns a timeout error
 * result instead of throwing so the agent loop can continue gracefully.
 *
 * Two independent mechanisms enforce the deadline:
 * 1. A `setTimeout` that resolves the timeout sentinel after `timeoutMs`.
 * 2. A periodic watchdog (`setInterval`) that checks elapsed time and
 *    force-resolves the sentinel if `setTimeout` failed to fire. This
 *    guards against event-loop stalls where `setTimeout` callbacks are
 *    delayed indefinitely.
 */
export async function executeWithTimeout(
  promise: Promise<ToolExecutionResult>,
  timeoutMs: number,
  toolName: string,
): Promise<ToolExecutionResult> {
  // Guard against NaN/invalid values that would cause setTimeout to fire immediately
  const safeMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TOOL_TIMEOUT_SEC * 1000;

  const startTime = Date.now();

  // The resolve function is shared between setTimeout and the watchdog so
  // either can trip the sentinel. Once resolved, subsequent calls are no-ops.
  let resolveTimeout: ((v: typeof TIMEOUT_SENTINEL) => void) | undefined;

  const watchdogHandle = setInterval(() => {
    const elapsedMs = Date.now() - startTime;
    const elapsedSec = Math.round(elapsedMs / 1000);
    const timeoutSec = Math.round(safeMs / 1000);
    if (elapsedMs > safeMs) {
      log.error(
        { toolName, elapsedSec, timeoutSec },
        `Tool "${toolName}" still running ${elapsedSec}s after ${timeoutSec}s timeout — forcing timeout from watchdog`,
      );
      // Force-resolve: the primary setTimeout didn't fire in time.
      resolveTimeout?.(TIMEOUT_SENTINEL);
    } else {
      log.warn(
        { toolName, elapsedSec, timeoutSec },
        `Tool "${toolName}" still executing after ${elapsedSec}s (timeout: ${timeoutSec}s)`,
      );
    }
  }, WATCHDOG_INTERVAL_MS);

  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    resolveTimeout = resolve;
    timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), safeMs);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    if (result === TIMEOUT_SENTINEL) {
      const elapsedMs = Date.now() - startTime;
      const sec = Math.round(safeMs / 1000);
      log.error(
        { toolName, timeoutSec: sec, elapsedMs },
        `Tool "${toolName}" timed out after ${sec}s`,
      );
      return {
        content: `Tool "${toolName}" timed out after ${sec}s. The operation may still be running in the background. Consider increasing timeouts.toolExecutionTimeoutSec in the config.`,
        isError: true,
      };
    }

    // Tool completed normally — log duration for observability
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > 60_000) {
      log.warn(
        { toolName, elapsedMs, elapsedSec: Math.round(elapsedMs / 1000) },
        `Tool "${toolName}" completed after ${Math.round(elapsedMs / 1000)}s (slow)`,
      );
    }

    return result;
  } finally {
    clearTimeout(timeoutHandle!);
    clearInterval(watchdogHandle);
  }
}
