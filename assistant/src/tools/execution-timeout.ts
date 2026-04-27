import type { ToolExecutionResult } from "./types.js";

const TIMEOUT_SENTINEL = Symbol("tool-timeout");

const DEFAULT_TOOL_TIMEOUT_SEC = 120;

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
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), safeMs);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    if (result === TIMEOUT_SENTINEL) {
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
