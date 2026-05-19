/**
 * Module-level latches for APNs remote push state.
 *
 * These live at module scope (not React state) for two reasons:
 *
 *   1. **Cold-launch capture**: when the user taps a notification while the
 *      app is fully suspended, iOS launches the app and Capacitor fires
 *      `pushNotificationActionPerformed` *before* React has mounted. Storing
 *      `pendingPushNavigation` here lets the AssistantPageClient mount effect
 *      consume it on first paint.
 *
 *   2. **Logout DELETE**: PR 11 needs the most-recently-registered token to
 *      issue a best-effort DELETE before `allauthLogout()`. Caching it at
 *      module scope (rather than threading it through context) keeps the
 *      logout path simple.
 *
 * The latches are intentionally mutable. There is no observable / pub-sub
 * here because nothing inside React renders off them; the only consumers are
 * one-shot effects (mount, logout) and the push event handlers themselves.
 */

export type ApnsEnvironment = "production" | "development";

export interface PushState {
  /**
   * Deep-link captured from a cold-launch `pushNotificationActionPerformed`.
   * Consumed (and cleared) by the AssistantPageClient first-mount effect in
   * PR 10. Stays `null` when the app is launched normally.
   */
  pendingPushNavigation: string | null;

  /** APNs device token returned by the most recent successful `register()`. */
  currentToken: string | null;

  /** iOS app bundle id the `currentToken` was registered under. */
  currentBundleId: string | null;

  /** APNs server environment (`production` / `development`) for the token. */
  currentApnsEnvironment: ApnsEnvironment | null;

  /**
   * Assistant id the `currentToken` was registered under. Required by the
   * logout DELETE path in PR 11 because the platform endpoint is scoped to
   * `(assistant_id, token, bundle_id)` and `auth.tsx` does not have direct
   * access to the active assistantId at logout time.
   */
  currentAssistantId: string | null;
}

export const pushState: PushState = {
  pendingPushNavigation: null,
  currentToken: null,
  currentBundleId: null,
  currentApnsEnvironment: null,
  currentAssistantId: null,
};

/** Test-only reset helper. Not exported from `index.ts`. */
export function __resetPushStateForTests(): void {
  pushState.pendingPushNavigation = null;
  pushState.currentToken = null;
  pushState.currentBundleId = null;
  pushState.currentApnsEnvironment = null;
  pushState.currentAssistantId = null;
}
