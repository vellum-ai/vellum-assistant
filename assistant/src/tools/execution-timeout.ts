import { DEFAULT_TOOL_EXECUTION_TIMEOUT_SEC } from "../api/constants/tool-execution.js";
import type { ToolExecutionResult } from "./types.js";

const TIMEOUT_SENTINEL = Symbol("tool-timeout");

/**
 * Content of the synthetic `tool_result` written for a tool call the user
 * cancelled before the call was ever dispatched to its tool.
 */
export const CANCELLED_TOOL_RESULT = "Cancelled by user";

/**
 * Content of the synthetic `tool_result` written for a tool call that was
 * still in flight when the user cancelled and did not settle. A tool that
 * does not read `context.signal` keeps running after the caller abandons it,
 * so the model is told the work may have landed rather than that it did not.
 */
export const CANCELLED_UNSETTLED_TOOL_RESULT =
  "Cancelled by user before the tool finished; it may still have completed, check before repeating it.";

/**
 * Upper bound on how long a caller waits after an abort for in-flight tool
 * calls to settle. A tool that honours the signal settles as soon as the
 * signal fires and so reports its real outcome; one that ignores the signal is
 * abandoned at this bound and reported as unsettled.
 */
export const ABORT_SETTLE_GRACE_MS = 50;

/**
 * Convert a config-provided seconds value to a safe milliseconds value,
 * falling back to the default if the input is NaN, non-finite, zero, or negative.
 *
 * `fallbackMs` lets callers governed by a different budget (e.g. the inline
 * grant wait) keep their own floor instead of inheriting the tool-execution
 * default.
 */
export function safeTimeoutMs(
  sec: unknown,
  fallbackMs: number = DEFAULT_TOOL_EXECUTION_TIMEOUT_SEC * 1000,
): number {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) {
    return fallbackMs;
  }
  return n * 1000;
}

/** Settlement state of a promise a caller may abandon before it finishes. */
export interface SettlementTracker<T> {
  /** The tracked promise. Awaiting it is equivalent to awaiting the original. */
  readonly promise: Promise<T>;
  /** True once the tracked promise has fulfilled or rejected. */
  isSettled(): boolean;
  /** The value when the tracked promise fulfilled, otherwise undefined. */
  fulfilledValue(): T | undefined;
}

/**
 * Observe whether a promise has settled without changing what awaiting it
 * does. Callers that race a promise against a timeout or an abort signal use
 * this to tell a call whose work actually finished from one they walked away
 * from while it was still running.
 */
export function trackSettlement<T>(promise: Promise<T>): SettlementTracker<T> {
  let settled = false;
  let value: T | undefined;
  const tracked = promise.then(
    (result) => {
      settled = true;
      value = result;
      return result;
    },
    (err) => {
      settled = true;
      throw err;
    },
  );
  return {
    promise: tracked,
    isSettled: () => settled,
    fulfilledValue: () => value,
  };
}

/**
 * Race a tool execution promise against a timeout. Returns a timeout error
 * result instead of throwing so the agent loop can continue gracefully.
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
      : DEFAULT_TOOL_EXECUTION_TIMEOUT_SEC * 1000;
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), safeMs);
  });
  const tracked = trackSettlement(promise);
  try {
    const result = await Promise.race([tracked.promise, timeoutPromise]);
    if (result === TIMEOUT_SENTINEL) {
      // The tool may have finished in the same tick the timer fired and lost
      // the race. Its real result is more honest than the timeout hedge.
      const settledResult = tracked.fulfilledValue();
      if (settledResult !== undefined) {
        return settledResult;
      }
      const sec = Math.round(safeMs / 1000);
      return {
        content: `Tool "${toolName}" timed out after ${sec}s. The operation may still be running in the background. Consider increasing timeouts.toolExecutionTimeoutSec in the config.`,
        isError: true,
      };
    }
    return result;
  } finally {
    clearTimeout(timeoutHandle!);
  }
}
