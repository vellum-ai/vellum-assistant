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
export type OrgHeaderWaitOutcome =
  "ready" | "unavailable" | "timeout" | "cancelled";

export interface AwaitOrgHeaderSettledOptions {
  /**
   * Ceiling on `"resolving"`, defaulting to
   * {@link ORG_HEADER_SETTLE_TIMEOUT_MS}.
   */
  timeoutMs?: number;
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
   * Held to the same ceiling.
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
 * a non-`"ready"` outcome means is the caller's call: the background hatch
 * fails retryably, the SetupIntent return fires its request anyway and reports
 * the failure.
 */
export async function awaitOrgHeaderSettled({
  timeoutMs = ORG_HEADER_SETTLE_TIMEOUT_MS,
  isCancelled,
  registerTimer,
  alsoReady,
  onWaiting,
}: AwaitOrgHeaderSettledOptions = {}): Promise<OrgHeaderWaitOutcome> {
  const startedAt = Date.now();
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
    if (onWaiting?.(readiness) !== true) {
      if (readiness === "unavailable") {
        return "unavailable";
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return "timeout";
      }
    }
    await sleep();
  }
}
