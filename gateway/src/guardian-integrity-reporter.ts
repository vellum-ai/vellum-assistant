// Fail-loud reporting for a gateway DB that has lost its guardian rows while
// carrying evidence of prior onboarding (see auth/guardian-integrity.ts).
// Emits an error-level log and relays a `gateway_guardian_missing` watchdog
// telemetry event to the daemon's internal telemetry route, which POSTs it
// directly to platform ingest — bypassing any state owned by the broken trust
// path so the alarm cannot suppress itself. Rate-limited per process; a lost
// event is acceptable for a rare, high-signal check (no retry).

import { loadConfig } from "./config.js";
import type { fetchImpl } from "./fetch.js";
import { postInternalTelemetry } from "./internal-telemetry-client.js";
import { getLogger } from "./logger.js";

const log = getLogger("guardian-integrity-reporter");

/**
 * Watchdog `check_name` for the missing-guardian integrity failure. Platform
 * dashboards filter on this exact string — it is the cross-repo contract.
 */
export const GUARDIAN_MISSING_CHECK_NAME = "gateway_guardian_missing";

const ROUTE_PATH = "/v1/internal/telemetry/watchdog";
const REPORT_INTERVAL_MS = 60 * 60 * 1000;

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
let lastReportAt = Number.NEGATIVE_INFINITY;
let pendingRelay: Promise<unknown> = Promise.resolve();

/**
 * Report the missing-guardian state: error log + telemetry relay. Fires on
 * the first detection per process and at most hourly thereafter (the state is
 * sticky until the guardian is re-seeded, so every verdict would otherwise
 * re-fire it). Fire-and-forget — never throws, never blocks the caller.
 */
export function reportMissingGuardian(detail: Record<string, unknown>): void {
  const now = Date.now();
  if (now - lastReportAt < REPORT_INTERVAL_MS) {
    return;
  }
  lastReportAt = now;

  reporterLog().error(
    detail,
    "gateway DB has no guardian rows but evidence of prior onboarding — " +
      "trust verdicts will fail closed until the guardian is re-seeded",
  );

  pendingRelay = relayToDaemon(detail).catch((err) => {
    reporterLog().warn(
      { err },
      "guardian-missing telemetry relay failed (non-fatal)",
    );
  });
}

async function relayToDaemon(detail: Record<string, unknown>): Promise<void> {
  const resp = await postInternalTelemetry({
    baseUrl: overrides.baseUrl ?? loadConfig().assistantRuntimeBaseUrl,
    path: ROUTE_PATH,
    body: { check_name: GUARDIAN_MISSING_CHECK_NAME, detail },
    fetchImpl: overrides.fetchImpl,
    mintToken: overrides.mintToken,
  });
  if (!resp.ok) {
    reporterLog().warn(
      { status: resp.status },
      "guardian-missing telemetry relay rejected (non-fatal)",
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
export function setGuardianIntegrityReporterOverridesForTesting(
  next: ReporterOverrides,
): void {
  overrides = next;
}

/** Test-only: clear overrides and the rate-limit window. */
export function resetGuardianIntegrityReporterForTesting(): void {
  overrides = {};
  lastReportAt = Number.NEGATIVE_INFINITY;
  pendingRelay = Promise.resolve();
}

/** Test-only: await the most recent fire-and-forget relay. */
export function flushGuardianIntegrityReporterForTesting(): Promise<unknown> {
  return pendingRelay;
}
