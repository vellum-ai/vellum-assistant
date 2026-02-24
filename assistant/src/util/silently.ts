import { getLogger } from './logger.js';

const log = getLogger('silently');

/**
 * Attaches a `.catch()` to `promise` that emits a debug-level log instead of
 * swallowing the rejection completely.  Use this in place of bare
 * `.catch(() => {})` when you need fire-and-forget semantics but still want
 * visibility into unexpected errors during debugging.
 *
 * The original promise is returned unchanged so callers can still chain it.
 *
 * @example
 *   silentlyWithLog(stopSession(id), 'idle session cleanup');
 */
export function silentlyWithLog<T>(promise: Promise<T>, context: string): Promise<T> {
  promise.catch((err: unknown) => {
    log.debug({ err, context }, 'Suppressed async error');
  });
  return promise;
}
