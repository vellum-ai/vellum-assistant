// Fail-loud reporting for a daemon that rejects a typed contacts mirror op
// with "Unknown method" (old daemon behind a newer gateway). The mirror ops
// deliberately have no raw-SQL fallback, so the gateway write has already
// applied while the assistant mirror silently missed it — divergence persists
// until reconciliation. Emits an error-level log and relays a
// `contacts_mirror_op_missing` watchdog telemetry event to the daemon's
// internal telemetry route (the route predates the mirror ops, so an old
// daemon still accepts it). Rate-limited per op per process; a lost event is
// acceptable for a rare, high-signal check (no retry). Scaffolding:
// watchdog-reporter.ts.

import { getLogger } from "./logger.js";
import { createWatchdogReporter } from "./watchdog-reporter.js";

/**
 * Watchdog `check_name` for a daemon missing a contacts mirror op. Platform
 * dashboards filter on this exact string — it is the cross-repo contract.
 */
export const MIRROR_OP_MISSING_CHECK_NAME = "contacts_mirror_op_missing";

/**
 * True when a daemon IPC failure is the IPC server's unknown-method rejection
 * (`error: "Unknown method: <m>"`, surfaced by ipcCallAssistant as an
 * IpcTransportError carrying that message verbatim).
 */
export function isUnknownIpcMethodError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("Unknown method:");
}

const reporter = createWatchdogReporter({
  log: getLogger("contacts-mirror-op-reporter"),
  relayFailedMessage: "mirror-op-missing telemetry relay failed (non-fatal)",
  relayRejectedMessage:
    "mirror-op-missing telemetry relay rejected (non-fatal)",
});

/**
 * Report a mirror op the daemon doesn't implement: error log + telemetry
 * relay. At most one report per op per hour per process. Fire-and-forget —
 * never throws, never blocks the caller.
 */
export function reportMirrorOpMissing(
  op: string,
  detail: Record<string, unknown>,
): void {
  reporter.report({
    key: op,
    checkName: MIRROR_OP_MISSING_CHECK_NAME,
    message:
      "daemon does not implement this contacts mirror op — gateway write applied " +
      "without the assistant mirror (divergence until the daemon updates)",
    detail: { op, ...detail },
    warnContext: { op },
  });
}

/** Test-only seams; see {@link createWatchdogReporter}. */
export const setMirrorOpReporterOverridesForTesting =
  reporter.setOverridesForTesting;
export const resetMirrorOpReporterForTesting = reporter.resetForTesting;
export const flushMirrorOpReporterForTesting = reporter.flushForTesting;
