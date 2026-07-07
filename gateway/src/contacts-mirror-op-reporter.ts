// Fail-loud reporting for a daemon that rejects a typed contacts mirror op
// with "Unknown method" (old daemon behind a newer gateway). The mirror ops
// deliberately have no raw-SQL fallback, so the gateway write has already
// applied while the assistant mirror silently missed it — divergence persists
// until reconciliation. Emits an error-level log and relays a
// `contacts_mirror_op_missing` watchdog telemetry event to the daemon's
// internal telemetry route (the route predates the mirror ops, so an old
// daemon still accepts it). Rate-limited per op per process; a lost event is
// acceptable for a rare, high-signal check (no retry). Pattern:
// guardian-integrity-reporter.

import { loadConfig } from "./config.js";
import type { fetchImpl } from "./fetch.js";
import { postInternalTelemetry } from "./internal-telemetry-client.js";
import { getLogger } from "./logger.js";

const log = getLogger("contacts-mirror-op-reporter");

/**
 * Watchdog `check_name` for a daemon missing a contacts mirror op. Platform
 * dashboards filter on this exact string — it is the cross-repo contract.
 */
export const MIRROR_OP_MISSING_CHECK_NAME = "contacts_mirror_op_missing";

const ROUTE_PATH = "/v1/internal/telemetry/watchdog";
const REPORT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * True when a daemon IPC failure is the IPC server's unknown-method rejection
 * (`error: "Unknown method: <m>"`, surfaced by ipcCallAssistant as an
 * IpcTransportError carrying that message verbatim).
 */
export function isUnknownIpcMethodError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("Unknown method:");
}

type ReporterLog = {
  error: (detail: Record<string, unknown>, msg: string) => void;
  warn: (detail: Record<string, unknown>, msg: string) => void;
};

type ReporterOverrides = {
  fetchImpl?: typeof fetchImpl;
  mintToken?: () => string;
  baseUrl?: string;
  log?: ReporterLog;
};

let overrides: ReporterOverrides = {};
const lastReportAtByOp = new Map<string, number>();
let pendingRelay: Promise<unknown> = Promise.resolve();

/**
 * Report a mirror op the daemon doesn't implement: error log + telemetry
 * relay. At most one report per op per hour per process. Fire-and-forget —
 * never throws, never blocks the caller.
 */
export function reportMirrorOpMissing(
  op: string,
  detail: Record<string, unknown>,
): void {
  const now = Date.now();
  const last = lastReportAtByOp.get(op) ?? Number.NEGATIVE_INFINITY;
  if (now - last < REPORT_INTERVAL_MS) {
    return;
  }
  lastReportAtByOp.set(op, now);

  reporterLog().error(
    { op, ...detail },
    "daemon does not implement this contacts mirror op — gateway write applied " +
      "without the assistant mirror (divergence until the daemon updates)",
  );

  pendingRelay = relayToDaemon(op, detail).catch((err) => {
    reporterLog().warn(
      { op, err },
      "mirror-op-missing telemetry relay failed (non-fatal)",
    );
  });
}

async function relayToDaemon(
  op: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const resp = await postInternalTelemetry({
    baseUrl: overrides.baseUrl ?? loadConfig().assistantRuntimeBaseUrl,
    path: ROUTE_PATH,
    body: {
      check_name: MIRROR_OP_MISSING_CHECK_NAME,
      detail: { op, ...detail },
    },
    fetchImpl: overrides.fetchImpl,
    mintToken: overrides.mintToken,
  });
  if (!resp.ok) {
    reporterLog().warn(
      { op, status: resp.status },
      "mirror-op-missing telemetry relay rejected (non-fatal)",
    );
  }
}

function reporterLog(): ReporterLog {
  return overrides.log ?? log;
}

/**
 * Test-only: inject fetch/token/baseUrl/log so tests never touch the network
 * or the process logger.
 */
export function setMirrorOpReporterOverridesForTesting(
  next: ReporterOverrides,
): void {
  overrides = next;
}

/** Test-only: clear overrides and the rate-limit windows. */
export function resetMirrorOpReporterForTesting(): void {
  overrides = {};
  lastReportAtByOp.clear();
  pendingRelay = Promise.resolve();
}

/** Test-only: await the most recent fire-and-forget relay. */
export function flushMirrorOpReporterForTesting(): Promise<unknown> {
  return pendingRelay;
}
