
/**
 * Best-effort APNs token unregistration on logout.
 *
 * Called from `web/src/lib/auth.tsx`'s `logout` callback **before**
 * `allauthLogout()` so the auth cookie is still valid when the DELETE
 * goes out. The platform endpoint
 * (`DELETE /v1/assistants/{assistant_id}/push-tokens/{token}/?bundle_id=…`)
 * is gated by the same `AssistantAPIKeyAuthentication` as the upsert,
 * which is why ordering matters: deleting after `allauthLogout()` would
 * 401 every time.
 *
 * Failures are deliberately swallowed — logout MUST complete even when
 * the platform is unreachable. A stale token row will eventually fall off
 * via natural APNs feedback (per the design doc's pruning loop) so the
 * worst case is one extra silent push to a now-logged-out device, which
 * the daemon's `PlatformPushAdapter` (Phase 4) is responsible for
 * filtering by tenancy.
 *
 * State invariant: regardless of HTTP outcome, the function clears the
 * full `pushState` registration latch. The next login on the same device
 * will re-POST a fresh token via `initializePushNotifications`.
 */

import * as Sentry from "@sentry/react";

import { client } from "@/generated/api/client.gen.js";
import { assistantsPushTokensDelete } from "@/generated/api/sdk.gen.js";
// Side-effect import: registers CSRF + Vellum-Organization-Id interceptors
// on the generated client. Mirrors `register.ts` and `notifications/native.ts`.
import "@/lib/vellum-api/client.js";

import { pushState } from "@/lib/push/state.js";

/**
 * Issue a best-effort `DELETE /v1/assistants/{id}/push-tokens/{token}/`
 * scoped to the bundle the token was registered under, then clear the
 * full registration latch.
 *
 * No-ops (without a network call) if any of token, bundle id, or
 * assistant id is missing — those represent either a never-registered
 * device (e.g. user denied permission) or a state that was already
 * cleared by a prior logout. In either case we still flush the latch
 * defensively in `finally` to keep state consistent.
 */
export async function deletePushTokenBestEffort(): Promise<void> {
  const { currentToken, currentBundleId, currentAssistantId } = pushState;

  if (!currentToken || !currentBundleId || !currentAssistantId) {
    // Defensive flush: idempotent and cheap. Aligns with the post-DELETE
    // finally below so callers can rely on "after this returns, the
    // registration latch is null."
    pushState.currentToken = null;
    pushState.currentBundleId = null;
    pushState.currentApnsEnvironment = null;
    pushState.currentAssistantId = null;
    return;
  }

  try {
    await assistantsPushTokensDelete({
      client,
      path: { assistant_id: currentAssistantId, token: currentToken },
      query: { bundle_id: currentBundleId },
      throwOnError: true,
    });
  } catch (err) {
    // Sentry capture so we can spot regressions; this is best-effort and
    // intentionally must not block the logout flow.
    Sentry.captureException(err, {
      tags: { component: "push-unregister", action: "delete" },
    });
    console.warn("[push] token DELETE failed; proceeding with logout", err);
  } finally {
    pushState.currentToken = null;
    pushState.currentBundleId = null;
    pushState.currentApnsEnvironment = null;
    pushState.currentAssistantId = null;
  }
}
