import LogRocket from "logrocket";

import { useAuthStore } from "@/stores/auth-store";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { getDeviceBool, watchDeviceSetting } from "@/utils/device-settings";

/**
 * The LogRocket SDK declares its option/request/response shapes in an
 * ambient `LR` namespace that `export =` does not re-export, so they are
 * derived from the SDK's own method signatures instead of referenced by
 * name. This keeps the call sites strongly typed without depending on the
 * unexported namespace.
 */
export type LogRocketOptions = NonNullable<Parameters<typeof LogRocket.init>[1]>;
export type LogRocketRequest = Parameters<
  NonNullable<NonNullable<LogRocketOptions["network"]>["requestSanitizer"]>
>[0];
export type LogRocketResponse = Parameters<
  NonNullable<NonNullable<LogRocketOptions["network"]>["responseSanitizer"]>
>[0];

/**
 * Gates the browser-side LogRocket session-replay client on the user's
 * "Help improve Vellum" toggle (`device:share_product_improvement`) AND
 * acceptance of the current privacy-policy version.
 *
 * Strict opt-in semantics — recording starts only when BOTH hold:
 *   - the toggle is explicitly `true` (absent / `false` → OFF), and
 *   - the user has accepted the current `CONSENT_VERSION` (mirrored into the
 *     onboarding store as `tosAccepted && aiDataConsent`, which are set true
 *     only when the accepted versions equal `CONSENT_VERSION`).
 *
 * Unlike Sentry, the LogRocket SDK exposes no public teardown; its supported
 * runtime gate is the `shouldSendData()` callback, consulted live before each
 * upload. `init()` therefore runs at most once (guarded by `initialized`);
 * opting out reactively stops uploads via `shouldSendData()` returning false,
 * and opting back in resumes them without re-initializing.
 *
 * Reference: https://docs.logrocket.com/reference/init
 */

let initialized = false;
let identifiedUserId: string | null = null;

/** True only when the user has accepted the current privacy-policy version. */
function currentVersionAccepted(): boolean {
  const state = useOnboardingStore.getState();
  return state.tosAccepted && state.aiDataConsent;
}

/**
 * Live consent check used both to gate the first `init()` and as the SDK's
 * per-upload `shouldSendData()` callback. Reads localStorage and the
 * onboarding store directly so a toggle flip or a fresh re-accept takes
 * effect immediately, without re-initializing.
 */
export function logRocketConsentGranted(): boolean {
  return getDeviceBool("shareProductImprovement", false) && currentVersionAccepted();
}

/** Identify the active session with the platform user id (id only). */
function identifyCurrentUser(): void {
  const userId = useAuthStore.getState().user?.id ?? null;
  if (!userId || userId === identifiedUserId) return;
  LogRocket.identify(userId);
  identifiedUserId = userId;
}

/**
 * Apply the current consent value to the LogRocket client — initialize once
 * when consent is granted, then keep the identified user in sync. When
 * consent is not granted, `shouldSendData()` already suppresses uploads, so
 * there is nothing to tear down. Idempotent.
 */
export function syncLogRocketClient(appId: string, options: LogRocketOptions): void {
  if (!appId) return;
  if (!logRocketConsentGranted()) return;
  if (!initialized) {
    LogRocket.init(appId, options);
    initialized = true;
  }
  identifyCurrentUser();
}

/**
 * Install listeners so LogRocket initializes / re-identifies whenever the
 * user flips the "Help improve Vellum" toggle (cross-tab `storage` event and
 * same-tab `vellum:pref-changed` event) or completes a fresh privacy-policy
 * acceptance (onboarding store update). Uploads are gated live by
 * `shouldSendData()`, so opt-out needs no listener-driven teardown.
 *
 * Returns a cleanup function that removes both subscriptions.
 */
export function installLogRocketControlListeners(
  appId: string,
  options: LogRocketOptions,
): () => void {
  const unwatchToggle = watchDeviceSetting("shareProductImprovement", () => {
    syncLogRocketClient(appId, options);
  });
  const unsubscribeStore = useOnboardingStore.subscribe(() => {
    syncLogRocketClient(appId, options);
  });
  return () => {
    unwatchToggle();
    unsubscribeStore();
  };
}
