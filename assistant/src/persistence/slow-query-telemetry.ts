/**
 * Wire slow-query logging to the watchdog telemetry store.
 *
 * Kept separate from {@link ./slow-query-log} so that module never imports the
 * telemetry store: `watchdog-events-store` imports `db-connection`, which imports
 * `slow-query-log`, so a static import there would form a cycle. This module is
 * imported only from daemon startup ({@link ../daemon/lifecycle}), outside that
 * chain, and installs the sink via {@link setSlowQueryTelemetrySink}.
 */

import { recordWatchdogEvent } from "../telemetry/watchdog-events-store.js";
import {
  setSlowQueryTelemetrySink,
  SLOW_QUERY_CHECK_NAME,
  type SlowQueryEvent,
} from "./slow-query-log.js";

/**
 * Record every slow query as a `watchdog` telemetry event so freezes are
 * attributable in aggregate, not just in the log file. The record is deferred to
 * a microtask: the sink fires from inside the (already slow) query's call stack,
 * so the synchronous INSERT is pushed off it to avoid adding to an in-progress
 * event-loop stall. Best-effort — a telemetry failure is swallowed.
 */
export function registerSlowQueryTelemetry(): void {
  setSlowQueryTelemetrySink((event: SlowQueryEvent) => {
    queueMicrotask(() => {
      try {
        recordWatchdogEvent({
          checkName: SLOW_QUERY_CHECK_NAME,
          value: event.durationMs,
          detail: {
            sql: event.sql,
            ...(event.rowCount === undefined
              ? {}
              : { rowCount: event.rowCount }),
            ...(event.label === undefined ? {} : { label: event.label }),
          },
        });
      } catch {
        // Best-effort — never let telemetry escape the query path.
      }
    });
  });
}
