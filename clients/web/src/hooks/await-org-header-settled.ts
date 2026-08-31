import {
  getOrgHeaderReadiness,
  ORG_HEADER_SETTLE_TIMEOUT_MS,
  type OrgHeaderReadiness,
} from "@/hooks/use-is-org-ready";

/**
 * Cadence for the wait below. Tighter than the polls that wait on server work:
 * the org store hydrates in one round trip, so every tick is dead time before
 * the request the caller is holding.
 */
const ORG_HEADER_POLL_INTERVAL_MS = 100;

/** How {@link awaitOrgHeaderSettled} ended. */
type OrgHeaderWaitOutcome = "ready" | "cancelled" | "failed";

interface AwaitOrgHeaderSettledOptions {
  /** Cooperative cancellation, checked before every readiness read. */
  isCancelled?: () => boolean;
  /**
   * Receives each pending poll timer (and null when it fires), so a caller can
   * clear it on unmount.
   */
  registerTimer?: (timer: ReturnType<typeof setTimeout> | null) => void;
  /**
   * An extra condition that must hold before a `"ready"` header resolves the
   * wait, for callers whose readiness is the header source plus something else.
   * Held to its own ceiling, which starts when the header first reads
   * `"ready"`, so a slow header cannot starve this one.
   */
  alsoReady?: () => boolean;
  /**
   * Runs on every tick the wait isn't ready, before `"unavailable"` and the
   * ceiling are treated as terminal. Return true to keep waiting past this
   * tick: a caller that re-triggered org resolution has a fresh answer coming.
   */
  onWaiting?: (readiness: OrgHeaderReadiness) => boolean;
}

/**
 * Wait for the `Vellum-Organization-Id` header source to be able to answer.
 *
 * Every platform request is scoped by that header, which the interceptor reads
 * from the org store, and that store hydrates after auth: a request fired
 * before it lands is header-less and rejected. Imperative sequences that must
 * not fire one early poll {@link getOrgHeaderReadiness} through here.
 *
 * Bounded on purpose. `"resolving"` is transient by construction, but a wait
 * with no ceiling would hold the caller's sequence for the rest of the visit if
 * it ever weren't, and `"unavailable"` never becomes `"ready"` on its own. What
 * a `"failed"` outcome means is the caller's call: the background hatch fails
 * retryably, the SetupIntent return fires its request anyway and reports the
 * failure.
 */
export async function awaitOrgHeaderSettled({
  isCancelled,
  registerTimer,
  alsoReady,
  onWaiting,
}: AwaitOrgHeaderSettledOptions = {}): Promise<OrgHeaderWaitOutcome> {
  let phaseStartedAt = Date.now();
  let headerSettled = false;
  // Parks the pending handle so a caller can clear it, and once cancelled
  // resolves without scheduling anything, so the loop reaches its next check
  // with no timer left behind.
  const sleep = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (isCancelled?.() === true) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        registerTimer?.(null);
        resolve();
      }, ORG_HEADER_POLL_INTERVAL_MS);
      registerTimer?.(timer);
    });

  while (true) {
    if (isCancelled?.() === true) {
      return "cancelled";
    }
    const readiness = getOrgHeaderReadiness();
    if (readiness === "ready" && (alsoReady?.() ?? true)) {
      return "ready";
    }
    // The header and `alsoReady` are sequential waits on unrelated sources, so
    // each gets the full ceiling rather than sharing one budget.
    if (!headerSettled && readiness === "ready") {
      headerSettled = true;
      phaseStartedAt = Date.now();
    }
    if (onWaiting?.(readiness) !== true) {
      if (readiness === "unavailable") {
        return "failed";
      }
      if (Date.now() - phaseStartedAt >= ORG_HEADER_SETTLE_TIMEOUT_MS) {
        return "failed";
      }
    }
    await sleep();
  }
}
