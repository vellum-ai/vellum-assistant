// Fail-loud reporting for guardian-integrity failures: a gateway DB that has
// lost its guardian rows while carrying evidence of prior onboarding
// (`gateway_guardian_missing`, see auth/guardian-integrity.ts) and a refused
// vellum-guardian mint (`gateway_guardian_mint_refused`, see
// auth/guardian-bootstrap.ts). Emits an error-level log and relays a watchdog
// telemetry event to the daemon's internal telemetry route, which POSTs it
// directly to platform ingest — bypassing any state owned by the broken trust
// path so the alarm cannot suppress itself. Rate-limited per check_name per
// process; a lost event is acceptable for a rare, high-signal check (no
// retry).

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

/**
 * Watchdog `check_name` for a refused vellum-guardian mint (evidence of a
 * prior guardian, no active vellum binding). Fires even when the integrity
 * state is `ok` — a guardian contact row can be intact while the vellum
 * binding is lost/inactive, and clients see `guardian_repair_required` 401s.
 */
export const GUARDIAN_MINT_REFUSED_CHECK_NAME = "gateway_guardian_mint_refused";

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
const lastReportAtByCheck = new Map<string, number>();
let pendingRelay: Promise<unknown> = Promise.resolve();

/**
 * Report the missing-guardian state: error log + telemetry relay. Fires on
 * the first detection per process and at most hourly thereafter (the state is
 * sticky until the guardian is re-seeded, so every verdict would otherwise
 * re-fire it). Fire-and-forget — never throws, never blocks the caller.
 */
export function reportMissingGuardian(detail: Record<string, unknown>): void {
  report(
    GUARDIAN_MISSING_CHECK_NAME,
    "gateway DB has no guardian rows but evidence of prior onboarding — " +
      "trust verdicts will fail closed until the guardian is re-seeded",
    detail,
  );
}

/**
 * Report a refused vellum-guardian mint: error log + telemetry relay. Same
 * per-check rate limiting and fire-and-forget semantics as
 * {@link reportMissingGuardian}; the sibling check_name distinguishes the
 * vellum-binding-lost-but-contact-intact refusal, which the missing-guardian
 * state check cannot see.
 */
export function reportGuardianMintRefused(
  detail: Record<string, unknown>,
): void {
  report(
    GUARDIAN_MINT_REFUSED_CHECK_NAME,
    "refused to mint a vellum guardian principal over evidence of a prior " +
      "guardian — clients get guardian_repair_required until re-pair",
    detail,
  );
}

function report(
  checkName: string,
  message: string,
  detail: Record<string, unknown>,
): void {
  const now = Date.now();
  const lastReportAt =
    lastReportAtByCheck.get(checkName) ?? Number.NEGATIVE_INFINITY;
  if (now - lastReportAt < REPORT_INTERVAL_MS) {
    return;
  }
  lastReportAtByCheck.set(checkName, now);

  reporterLog().error(detail, message);

  pendingRelay = relayToDaemon(checkName, detail).catch((err) => {
    reporterLog().warn(
      { err, checkName },
      "guardian-integrity telemetry relay failed (non-fatal)",
    );
  });
}

async function relayToDaemon(
  checkName: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const resp = await postInternalTelemetry({
    baseUrl: overrides.baseUrl ?? loadConfig().assistantRuntimeBaseUrl,
    path: ROUTE_PATH,
    body: { check_name: checkName, detail },
    fetchImpl: overrides.fetchImpl,
    mintToken: overrides.mintToken,
  });
  if (!resp.ok) {
    reporterLog().warn(
      { status: resp.status, checkName },
      "guardian-integrity telemetry relay rejected (non-fatal)",
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

/** Test-only: clear overrides and the rate-limit windows. */
export function resetGuardianIntegrityReporterForTesting(): void {
  overrides = {};
  lastReportAtByCheck.clear();
  pendingRelay = Promise.resolve();
}

/** Test-only: await the most recent fire-and-forget relay. */
export function flushGuardianIntegrityReporterForTesting(): Promise<unknown> {
  return pendingRelay;
}
