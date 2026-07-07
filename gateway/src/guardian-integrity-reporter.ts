// Fail-loud reporting for guardian-integrity failures: a gateway DB that has
// lost its guardian rows while carrying evidence of prior onboarding
// (`gateway_guardian_missing`, see auth/guardian-integrity.ts) and a refused
// vellum-guardian mint (`gateway_guardian_mint_refused`, see
// auth/guardian-bootstrap.ts). Emits an error-level log and relays a watchdog
// telemetry event to the daemon's internal telemetry route, which POSTs it
// directly to platform ingest — bypassing any state owned by the broken trust
// path so the alarm cannot suppress itself. Rate-limited per check_name per
// process; a lost event is acceptable for a rare, high-signal check (no
// retry). Scaffolding: watchdog-reporter.ts.

import { getLogger } from "./logger.js";
import { createWatchdogReporter } from "./watchdog-reporter.js";

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

const reporter = createWatchdogReporter({
  log: getLogger("guardian-integrity-reporter"),
  relayFailedMessage: "guardian-integrity telemetry relay failed (non-fatal)",
  relayRejectedMessage:
    "guardian-integrity telemetry relay rejected (non-fatal)",
});

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
  reporter.report({
    key: checkName,
    checkName,
    message,
    detail,
    warnContext: { checkName },
  });
}

/** Test-only seams; see {@link createWatchdogReporter}. */
export const setGuardianIntegrityReporterOverridesForTesting =
  reporter.setOverridesForTesting;
export const resetGuardianIntegrityReporterForTesting = reporter.resetForTesting;
export const flushGuardianIntegrityReporterForTesting = reporter.flushForTesting;
