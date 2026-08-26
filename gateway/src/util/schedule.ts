/**
 * An injectable one-shot timer.
 *
 * Every long-lived channel transport needs deadlines it can drive without
 * real time in tests (connect deadlines, heartbeat ticks, liveness probes),
 * so they all take their timer as a collaborator rather than calling
 * `setTimeout` directly. This is that collaborator, shared so the transports
 * agree on one shape instead of each declaring its own.
 */

/** Cancel handle returned by {@link ScheduleFn}. Safe to call more than once. */
export type CancelTimer = () => void;

/** Schedule `fn` after `delayMs`, returning a handle that cancels it. */
export type ScheduleFn = (fn: () => void, delayMs: number) => CancelTimer;

/**
 * The production timer. Unrefs so a pending deadline never keeps the gateway
 * process alive on its own.
 */
export const defaultSchedule: ScheduleFn = (fn, delayMs) => {
  const timer = setTimeout(fn, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};
