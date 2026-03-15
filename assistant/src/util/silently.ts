import { getLogger } from "./logger.js";

const log = getLogger("silently");

/**
 * Suppresses rejections from `promise`, logging them at debug level instead.
 * Use this in place of bare `.catch(() => {})` when you need fire-and-forget
 * semantics but still want visibility into unexpected errors during debugging.
 *
 * Returns the caught promise so `await silentlyWithLog(...)` never throws.
 *
 * @example
 *   silentlyWithLog(stopSession(id), 'idle session cleanup');
 *   await silentlyWithLog(rm(dir, { recursive: true }), 'cleanup');
 */
export function silentlyWithLog<T>(
  promise: Promise<T>,
  context: string,
): Promise<T | void> {
  return promise.catch((err: unknown) => {
    log.debug({ err, context }, "Suppressed async error");
  });
}
