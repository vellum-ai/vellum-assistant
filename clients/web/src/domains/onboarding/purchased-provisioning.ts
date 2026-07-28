/**
 * The post-payment provisioning wait, shared by every hatch entry point.
 *
 * Once a platform assistant is active and healthz-ready, hold until the
 * server-side resize to the purchased machine and storage specs converges, then
 * re-probe healthz (the resize restarts the pod). The reconcile is idempotent
 * and fire-and-forget; a genuinely free org, and the `RESIZE_WAIT_MAX_MS` cap,
 * fall through to completion at baseline, so a Pro hatch emerges at the right
 * size without ever trapping the user. Every wait that entered the provisioning
 * phase leaves through the healthz probe, and the caller must honour a
 * `health_timeout` outcome.
 *
 * Deliberately free of React: callers inject cancellation, the resize-phase
 * signal, and timer bookkeeping so the same wait runs behind a foreground
 * screen or inside a headless background hatch.
 */

import { getAssistant, getAssistantHealthz } from "@/assistant/api";
import {
  assistantsOperationalStatusDetailRead,
  organizationsBillingSubscriptionOnboardingEnsureProvisionedCreate,
  organizationsBillingSubscriptionOnboardingRetrieve,
  organizationsBillingSubscriptionRetrieve,
} from "@/generated/api/sdk.gen";
import { allowedMachineSizesForTier } from "@/lib/billing/machine-sizes";
import {
  isEntitlementRaceVerdict,
  isResizeOperationInFlight,
  targetsMet,
  type ProvisioningDimensions,
} from "@/lib/billing/provisioning-targets";
import { isLocalMode } from "@/lib/local-mode";

// Owned here: `MAX_HATCH_WAIT_MS` decides the `health_timeout` outcome below.
export const POLL_INTERVAL_MS = 3000;
export const MAX_HATCH_WAIT_MS = 300_000;
// Hard cap on the post-payment resize wait, mirroring PROVISION_STALL_MS in the
// pro-onboarding takeover. On expiry the assistant completes at baseline and the
// server reconciles the purchased specs later — the user is never trapped.
export const RESIZE_WAIT_MAX_MS = 90_000;

// How the purchased-provisioning wait ended. `health_timeout` means the
// assistant never answered healthz within MAX_HATCH_WAIT_MS after the resize,
// so the hatch must be failed rather than completed onto an unreachable pod.
export type PurchasedProvisioningOutcome = "ready" | "health_timeout";

export interface AwaitPurchasedProvisioningOptions {
  assistantId: string;
  /** This hatch is the return leg of a completed checkout (`post_checkout=1`). */
  postCheckoutReturn: boolean;
  /** `hosting=vellum-cloud` — a managed hatch even in a local-mode build. */
  managedHatch: boolean;
  /** Epoch ms the overall hatch poll started; bounds the post-resize health wait. */
  hatchStartMs: number;
  /** Cooperative cancellation — checked before every await resumes. */
  isCancelled: () => boolean;
  /** Fired once when the wait enters the resize-hold (the screen shows "resizing"). */
  onResizeWait?: () => void;
  /** Receives each pending poll timer (and null when it fires) so callers can clear it on unmount. */
  registerTimer?: (timer: ReturnType<typeof setTimeout> | null) => void;
}

export async function awaitPurchasedProvisioning(
  options: AwaitPurchasedProvisioningOptions,
): Promise<PurchasedProvisioningOutcome> {
  const {
    assistantId,
    postCheckoutReturn,
    managedHatch,
    hatchStartMs,
    isCancelled,
    onResizeWait,
    registerTimer,
  } = options;

  // A cancelled wait resolves without scheduling anything, so the loop reaches
  // its next check with no timer left behind.
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (isCancelled()) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        registerTimer?.(null);
        resolve();
      }, ms);
      registerTimer?.(timer);
    });

  // Purchased specs live on the platform, so only a managed hatch reads them. A
  // local-mode run without the managed marker can reach here off a preflight
  // that resolved the lockfile assistant, which has no billing surface —
  // short-circuit there.
  if (isLocalMode() && !managedHatch) {
    return "ready";
  }

  // Per-invocation guard: a retry re-nudges the idempotent reconcile once more,
  // which is harmless and self-limiting under the caps below.
  let reconcileFired = false;

  // Fire the idempotent grow-only reconcile — the same resize the subscribe
  // webhook triggers — covering a webhook that never fired or whose resize was
  // lost. It is marked done only when it RECONCILES: a 503 ("nothing queued"), a
  // network error, a pre-org-hydration mount, or a race reply leaves the guard
  // unset so a later poll iteration re-fires the nudge. It never blocks
  // completion (which keys off targets + op-status); the re-fires stay bounded
  // by the RESIZE_WAIT_MAX_MS cap below.
  const fireProvisioningReconcile = (): void => {
    if (reconcileFired) {
      return;
    }
    void organizationsBillingSubscriptionOnboardingEnsureProvisionedCreate({
      throwOnError: false,
    })
      .then((result) => {
        // Success carries a body; a 503/5xx resolves with no data under
        // throwOnError:false. A race body — the entitlement not yet visible, or
        // no settled assistant to provision, which is the common case this early
        // in a hatch — is not an answer: nothing was queued, so it must not
        // consume the guard or the nudge is lost for the whole hatch.
        if (result.data != null && !isEntitlementRaceVerdict(result.data)) {
          reconcileFired = true;
        }
      })
      .catch(() => {
        // Network/thrown error: leave the guard unset to re-fire on a later poll.
      });
  };

  // A reconciled resize restarts the pod, so every exit from the waits below
  // ends here before the hatch completes — otherwise the caller completes onto a
  // mid-restart daemon. Bounded by MAX_HATCH_WAIT_MS measured from the hatch
  // start, past which the assistant is not coming back and the hatch is a
  // failure.
  const waitForPostResizeHealth =
    async (): Promise<PurchasedProvisioningOutcome> => {
      while (!isCancelled()) {
        try {
          const health = await getAssistantHealthz(assistantId);
          if (health.ok) {
            return "ready";
          }
        } catch {
          // Daemon not reachable yet during the post-resize restart.
        }
        if (Date.now() - hatchStartMs >= MAX_HATCH_WAIT_MS) {
          return "health_timeout";
        }
        await sleep(POLL_INTERVAL_MS);
      }
      return "ready";
    };

  // The cap covers both waits below — the entitlement/targets confirmation and
  // the resize itself — so a lagging subscription can never hold the user past
  // RESIZE_WAIT_MAX_MS.
  const resizeDeadline = Date.now() + RESIZE_WAIT_MAX_MS;

  // Confirm the entitlement before concluding "free". A paid checkout can return
  // before the onboarding targets are visible, so gate the no-wait completion on
  // the actual subscription plan rather than on the first null targets. While the
  // plan reads Pro but the targets aren't provisioned yet (the entitlement race),
  // keep polling the subscription and targets within the cap instead of
  // completing at baseline.
  let targets: ProvisioningDimensions | null = null;
  while (!isCancelled()) {
    // Re-fire the reconcile until it succeeds (or the cap): a failed first
    // attempt must not permanently consume the guard.
    fireProvisioningReconcile();
    // Tri-state entitlement read. Only a CONFIRMED non-Pro plan — a successful
    // response whose plan_id is definitively not "pro" — completes early. An
    // unknown result (a thrown error, or a 5xx that resolves with no data under
    // throwOnError:false) must not be mistaken for "free"; it behaves like "Pro
    // but targets not yet provisioned" and keeps polling within the cap so a
    // purchased resize is never skipped.
    let subscriptionState: "pro" | "non_pro" | "unknown" = "unknown";
    try {
      const subscription = await organizationsBillingSubscriptionRetrieve({
        throwOnError: false,
      });
      if (isCancelled()) {
        return "ready";
      }
      if (subscription.data) {
        subscriptionState =
          subscription.data.plan_id === "pro" ? "pro" : "non_pro";
      }
    } catch {
      // Subscription endpoint blip: stay "unknown" and keep polling to the cap.
    }

    try {
      const onboarding =
        await organizationsBillingSubscriptionOnboardingRetrieve({
          throwOnError: false,
        });
      if (isCancelled()) {
        return "ready";
      }
      const data = onboarding.data;
      if (data) {
        targets = {
          machineSize:
            allowedMachineSizesForTier(data.max_machine_tier).at(-1) ?? null,
          storageGib: data.selected_storage_gib ?? null,
        };
      }
    } catch {
      // Targets fetch blip; keep polling to the cap.
    }

    const hasTargets =
      targets != null &&
      (targets.machineSize != null || targets.storageGib != null);

    // Confirmed non-Pro on an ordinary hatch — genuinely free. Complete exactly
    // as a non-provisioned hatch does today, with no added poll. On a
    // post-checkout return the same read is not an answer: Stripe redirects
    // before the subscribe webhook updates the org, so the plan still reads at
    // its pre-checkout base. That case falls through to the capped wait below.
    if (subscriptionState === "non_pro" && !postCheckoutReturn) {
      return "ready";
    }
    // Confirmed Pro with a purchased ceiling to wait on: hold for the resize
    // below.
    if (subscriptionState === "pro" && hasTargets) {
      break;
    }
    // Pro with targets not yet visible, a still-base read on a paid return, or
    // an unknown/errored subscription read: keep polling within the cap rather
    // than completing at baseline onto an unprovisioned assistant. The cap is
    // the ultimate escape, so a subscription that never flips — a
    // persistently-erroring endpoint, a lost webhook — still completes.
    if (Date.now() >= resizeDeadline) {
      // Nothing was confirmed, but the reconcile has been nudged on every
      // iteration, so a resize may already have restarted the pod. Health check
      // before completing rather than returning straight to the caller.
      return waitForPostResizeHealth();
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (isCancelled()) {
    return "ready";
  }

  // Hold in an in-progress phase while the resize lands.
  onResizeWait?.();

  while (!isCancelled()) {
    // Keep nudging the resize in case the reconcile hasn't landed yet; the guard
    // stops the re-fire once it succeeds.
    fireProvisioningReconcile();
    let actuals: ProvisioningDimensions | null = null;
    try {
      const actualsResult = await getAssistant(assistantId);
      if (isCancelled()) {
        return "ready";
      }
      if (actualsResult.ok) {
        actuals = {
          machineSize: actualsResult.data.machine_size ?? null,
          storageGib: actualsResult.data.provisioned_storage_gib ?? null,
        };
      }
    } catch {
      // Assistant endpoint unreachable mid-resize; keep polling to the cap.
    }

    // Default to in-flight so an uncertain status read withholds completion.
    // Under throwOnError:false a 5xx resolves with no data rather than throwing,
    // and isResizeOperationInFlight(undefined) is false — so only a successful
    // read (data present) may downgrade to "not in flight". Otherwise the caller
    // could complete onto a pod that is still restarting.
    let operationInFlight = true;
    try {
      const opStatus = await assistantsOperationalStatusDetailRead({
        path: { id: assistantId },
        throwOnError: false,
      });
      if (isCancelled()) {
        return "ready";
      }
      if (opStatus.data) {
        operationInFlight = isResizeOperationInFlight(opStatus.data);
      }
    } catch {
      // Operational-status endpoint unreachable mid-resize: retain the
      // conservative in-flight value and keep polling to the cap.
      operationInFlight = true;
    }

    // The platform persists the effective sizes before the pod finishes
    // restarting, so completion requires the resize operation to have cleared —
    // not just targets-met — to avoid landing on a soon-dead pod.
    if (targetsMet(targets, actuals) && !operationInFlight) {
      break;
    }
    if (Date.now() >= resizeDeadline) {
      // Cap reached: stop waiting for the resize but still fall through to the
      // healthz probe below, so completion never routes onto a pod mid-restart.
      // The server reconciles the remaining resize later.
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (isCancelled()) {
    return "ready";
  }

  // Both the converged and the cap-expiry exit above land on a pod the resize
  // may still be restarting.
  return waitForPostResizeHealth();
}
