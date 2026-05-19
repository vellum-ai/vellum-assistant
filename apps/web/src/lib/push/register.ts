
/**
 * APNs remote push registration for Capacitor iOS.
 *
 * `initializePushNotifications(assistantId)` is called once from the
 * AssistantPageClient mount effect when the user is authenticated and an
 * `assistantId` is known. It:
 *
 *   1. Short-circuits on non-iOS platforms.
 *   2. Asks for permission (cold-launch ask is the v1 default per design D5).
 *   3. Registers listeners *before* `PushNotifications.register()` so the
 *      one-shot `registration` event is captured (Capacitor 8 fires it
 *      synchronously after `register()` resolves).
 *   4. POSTs the token to `/v1/assistants/{id}/push-tokens/` via the
 *      generated HeyAPI SDK.
 *
 * PR 10 layers on top of this:
 *   - `pushNotificationReceived` consults the SSE-connected store and
 *     short-circuits when the in-app stream is delivering content live.
 *   - `pushNotificationActionPerformed` routes through a live deep-link
 *     handler if AssistantPageClient is mounted, otherwise stashes the
 *     deep link on `pushState` for cold-launch consumption.
 *   - `consumePendingPushNavigation()` is the read+clear helper used by
 *     the AssistantPageClient mount effect.
 *
 * Logout DELETE (PR 11) is intentionally NOT in this module yet.
 */

import * as Sentry from "@sentry/react";
import { Capacitor } from "@capacitor/core";

import { client } from "@/generated/api/client.gen.js";
import { assistantsPushTokensUpsert } from "@/generated/api/sdk.gen.js";
// Side-effect import: registers the CSRF + Vellum-Organization-Id interceptors
// on the generated client. Mirrors `@/lib/notifications/native.ts`.
import "@/lib/vellum-api/client.js";

import { getSSEConnectedSnapshot } from "@/domains/chat/lib/sse-connected-store.js";

import { pushState, type ApnsEnvironment } from "@/lib/push/state.js";

/**
 * Module-level guard so re-renders that re-fire the mount effect don't
 * register listeners more than once. Capacitor's `addListener` does not
 * dedupe — calling it twice would fire both handlers per event.
 */
let listenersRegistered = false;
let registrationInFlight: Promise<void> | null = null;

/**
 * Most-recently-known registration context. The `registration` listener is
 * registered exactly once per JS runtime, so it cannot close over `ctx` from
 * a single call without going stale across assistant switches. The mount
 * effect in `AssistantPageClient` re-runs on `[assistantId]` and calls
 * `initializePushNotifications` for the new pod; updating `latestCtx` on
 * every call (and reading it from inside the listener) keeps the next
 * `registration` event POSTing the token to the active assistant rather
 * than the one that registered the listener originally.
 *
 * Caught by Codex + Devin review on PR 9.
 */
let latestCtx: RegistrationContext | null = null;

/**
 * Latest assistantId requested via `initializePushNotifications` — read by
 * the in-flight IIFE when it first sets `latestCtx`. Without this, a
 * concurrent call during the permission/getBundleId await window would be
 * coalesced via the early-return on `registrationInFlight` AND the IIFE
 * would close over the *original* call's `assistantId` parameter, so the
 * eventual `registration` event POSTs the token under the stale assistant.
 *
 * Caught by Codex review on PR #6031.
 */
let pendingAssistantId: string | null = null;

/**
 * Live deep-link handler. AssistantPageClient registers itself here on
 * mount and unregisters on unmount. When set, an incoming
 * `pushNotificationActionPerformed` deep link routes through this callback
 * instead of stashing on `pushState.pendingPushNavigation`.
 *
 * The cold-launch path (app fully suspended, listener fires before React
 * mounts) bypasses this — the handler is null at that moment, so the deep
 * link gets stashed and consumed by the mount effect via
 * `consumePendingPushNavigation`.
 */
let liveDeepLinkHandler: ((deepLink: string) => void) | null = null;

/**
 * Register (or clear, with `null`) the live deep-link handler. Idempotent
 * overwrite is intentional — replacing an existing handler is normal
 * during HMR / dev StrictMode double-mount. Cleanup callers should pass
 * `null` to clear.
 */
export function setPushDeepLinkHandler(
  handler: ((deepLink: string) => void) | null,
): void {
  liveDeepLinkHandler = handler;
}

/**
 * Atomically read and clear `pushState.pendingPushNavigation`. Used by
 * AssistantPageClient's mount effect to consume any cold-launch deep link
 * once. Subsequent calls return `null` until the next push lands while no
 * live handler is registered.
 */
export function consumePendingPushNavigation(): string | null {
  const target = pushState.pendingPushNavigation;
  pushState.pendingPushNavigation = null;
  return target;
}

/**
 * iOS bundle suffix → APNs environment mapping.
 *
 * Source of truth is `web/ios/App/App/App-Dev.entitlements`
 * (`aps-environment = development`) and `App.entitlements`
 * (`aps-environment = production`, used by both prod and staging targets).
 *
 *   - `ai.vocify-inc.vellum-assistant-ios`         → production
 *   - `ai.vocify-inc.vellum-assistant-ios.staging` → production
 *   - `ai.vocify-inc.vellum-assistant-ios.dev`     → development
 *
 * Keep this in sync with `web/ios/App/App/Config/*.xcconfig` if the bundle
 * id scheme ever changes.
 */
function deriveApnsEnvironment(bundleId: string): ApnsEnvironment {
  return bundleId.endsWith(".dev") ? "development" : "production";
}

/**
 * Read the iOS bundle id at runtime via `@capacitor/app`'s `App.getInfo()`.
 * Imported lazily so non-iOS code paths never load the plugin (the web
 * bundle would still tree-shake it, but lazy loading keeps initial parse
 * costs zero and makes the platform check the single source of truth).
 */
async function getBundleId(): Promise<string> {
  const { App } = await import("@capacitor/app");
  const info = await App.getInfo();
  return info.id;
}

interface RegistrationContext {
  assistantId: string;
  bundleId: string;
  apnsEnvironment: ApnsEnvironment;
}

async function postTokenToPlatform(
  token: string,
  ctx: RegistrationContext,
): Promise<void> {
  try {
    await assistantsPushTokensUpsert({
      client,
      path: { assistant_id: ctx.assistantId },
      body: {
        token,
        platform: "ios",
        bundle_id: ctx.bundleId,
        apns_environment: ctx.apnsEnvironment,
      },
      throwOnError: true,
    });
    pushState.currentToken = token;
    pushState.currentBundleId = ctx.bundleId;
    pushState.currentApnsEnvironment = ctx.apnsEnvironment;
    pushState.currentAssistantId = ctx.assistantId;
  } catch (err) {
    // Best-effort — a transient platform error must not blow up app init.
    // Sentry captures the failure so we can spot regressions in the field.
    Sentry.captureException(err, {
      tags: { component: "push-register", action: "upsert" },
    });
    console.warn("[push] token upsert failed", err);
  }
}

/**
 * Register listeners and call `PushNotifications.register()`.
 *
 * Idempotent on the listener side: subsequent calls during the same JS
 * runtime no-op the listener wiring but still re-POST the latest cached
 * token under the (potentially new) assistantId.
 */
export async function initializePushNotifications(
  assistantId: string,
): Promise<void> {
  // SSR guard — the module is `"use client"`, but a tree-shake regression
  // could still pull this into a server bundle.
  if (typeof window === "undefined") return;

  if (Capacitor.getPlatform() !== "ios") return;

  if (!assistantId) return;

  // Track the latest desired assistant. Two consumers read this:
  //   1. The IIFE below, which uses it when first setting `latestCtx`
  //      (after permission/bundleId resolves) so a switch DURING the
  //      permission ask lands the eventual POST under the new assistant.
  //   2. The early-return path below, which folds the new assistantId into
  //      the already-set `latestCtx` so the in-flight `register()`'s
  //      `registration` listener — which reads `latestCtx` dynamically —
  //      POSTs the device token under the new assistant rather than the
  //      original one.
  pendingAssistantId = assistantId;

  // Coalesce concurrent calls so a re-mount during in-flight permission
  // prompts doesn't double-POST. The new assistantId still wins via the
  // `latestCtx` rebind below — the in-flight `register()`'s listener
  // reads `latestCtx` at fire time, so updating it here is sufficient.
  if (registrationInFlight) {
    if (latestCtx && latestCtx.assistantId !== assistantId) {
      latestCtx = { ...latestCtx, assistantId };
    }
    return registrationInFlight;
  }

  registrationInFlight = (async () => {
    try {
      // Destructure inline. Capacitor plugins are JS `Proxy` objects whose
      // `.then` access returns a callable wrapper (see
      // `@capacitor/core/dist/index.cjs.js` proxy `get` trap, default branch).
      // Returning the proxy from an `async` function triggers Promise
      // thenable adoption, which dispatches a `then()` method call to the
      // native iOS plugin and silently hangs the `await`. Inline destructure
      // matches `haptics.ts` / `browser.ts` / `native-file.ts` and the
      // `getBundleId()` helper above.
      const { PushNotifications } = await import(
        "@capacitor/push-notifications"
      );

      // Ask for permission first. iOS only displays the system prompt the
      // first time — subsequent calls return the cached state.
      const permission = await PushNotifications.requestPermissions();
      if (permission.receive !== "granted") {
        // User declined or "provisional" — do not register. The OS will not
        // deliver remote pushes anyway.
        return;
      }

      const bundleId = await getBundleId();
      const apnsEnvironment = deriveApnsEnvironment(bundleId);
      // Update the module-level `latestCtx` BEFORE any listener could fire.
      // The `registration` listener is registered once per JS runtime and
      // reads `latestCtx` at invocation time, so the next `register()` call
      // POSTs to the *currently active* assistantId, not the one that wired
      // the listener.
      //
      // Use `pendingAssistantId` rather than the captured `assistantId`
      // parameter: a concurrent `initializePushNotifications` call during
      // the awaits above updates `pendingAssistantId` and we want THAT
      // assistant — the active one — to receive the token.
      latestCtx = {
        assistantId: pendingAssistantId ?? assistantId,
        bundleId,
        apnsEnvironment,
      };

      if (!listenersRegistered) {
        // Listeners must be registered BEFORE `register()` so the one-shot
        // `registration` event isn't lost.
        await PushNotifications.addListener("registration", (token) => {
          // Read `latestCtx` dynamically — see the comment on its declaration
          // for why we don't close over the per-call `ctx`.
          const ctx = latestCtx;
          if (!ctx) return;
          void postTokenToPlatform(token.value, ctx);
        });

        await PushNotifications.addListener("registrationError", (err) => {
          Sentry.captureException(err, {
            tags: { component: "push-register", action: "registrationError" },
          });
          console.warn("[push] registration error", err);
        });

        await PushNotifications.addListener(
          "pushNotificationActionPerformed",
          (action) => {
            const data = action.notification?.data ?? {};
            const deepLink =
              typeof data.deepLink === "string" ? data.deepLink : null;
            if (!deepLink) {
              // No deep link payload — clear any stale latch from a prior
              // tap so a re-launch can't accidentally navigate to old
              // content, and bail. The live handler is intentionally NOT
              // invoked with a null target.
              pushState.pendingPushNavigation = null;
              return;
            }
            if (liveDeepLinkHandler) {
              // Background → foreground tap on a mounted app: route now.
              liveDeepLinkHandler(deepLink);
              pushState.pendingPushNavigation = null;
              return;
            }
            // Cold launch: AssistantPageClient hasn't mounted yet. Stash
            // for `consumePendingPushNavigation()` to drain on first paint.
            pushState.pendingPushNavigation = deepLink;
          },
        );

        await PushNotifications.addListener("pushNotificationReceived", () => {
          // Foreground SSE-aware suppression (PR 10 contract).
          //
          // When the always-on SSE stream is connected, the in-app chat UI
          // is already delivering this notification's payload live — any
          // OS-level surface would be redundant. Returning early documents
          // that intent at the JS layer.
          //
          // Implementation note: Capacitor 8.0.3's
          // `PushNotificationsHandler.willPresent` returns an empty
          // UNNotificationPresentationOptions when no `presentationOptions`
          // are configured in `capacitor.config.ts` — meaning iOS shows
          // nothing in foreground regardless of which branch we take here.
          // This early-return therefore has no observable banner effect
          // today, but is load-bearing for two near-future scenarios:
          //   1. Adding `presentationOptions: ["alert"]` to capacitor.config
          //      (with a native UNUserNotificationCenterDelegate override
          //      that bridges this JS state) to surface banners only when
          //      SSE is disconnected.
          //   2. Adding an in-app foreground toast fallback for the
          //      SSE-disconnected case.
          if (getSSEConnectedSnapshot()) {
            return;
          }
          // SSE not connected: leave the OS-default presentation behavior.
          // No fallback toast yet — that ships in a follow-up PR.
        });

        listenersRegistered = true;
      }

      await PushNotifications.register();
    } catch (err) {
      Sentry.captureException(err, {
        tags: { component: "push-register", action: "initialize" },
      });
      console.warn("[push] initialize failed", err);
    } finally {
      registrationInFlight = null;
    }
  })();

  return registrationInFlight;
}

/** Test-only reset helpers. Not exported from `index.ts`. */
export function __resetRegisterStateForTests(): void {
  listenersRegistered = false;
  registrationInFlight = null;
  latestCtx = null;
  pendingAssistantId = null;
  liveDeepLinkHandler = null;
}
