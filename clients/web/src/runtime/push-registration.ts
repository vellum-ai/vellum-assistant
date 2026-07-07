/**
 * APNs remote-push device-token registration and tap routing for the
 * Capacitor iOS app.
 *
 * The daemon's `platform` notification channel POSTs background notifications
 * (reminders, activity completions, etc.) to the Vellum platform's
 * `/v1/assistants/{id}/push/dispatch/` endpoint, which fans them out to every
 * APNs device token registered for the bound user. This module is the missing
 * client half: it asks iOS for an APNs device token via
 * `@capacitor/push-notifications`, then upserts that token to the platform so
 * the daemon has somewhere to deliver.
 *
 * Why this matters for reminders specifically: the in-app local-notification
 * path (`runtime/notifications.ts`) only fires while the JS runtime is alive
 * (foreground / recently-backgrounded). Scheduled reminders fire while the app
 * is backgrounded or suspended, so APNs remote push is the only path that can
 * reach the device. (LUM-1159)
 *
 * Lifecycle:
 *   - {@link registerForRemotePush} — call once an assistant is active. Requests
 *     notification permission, registers for APNs, and upserts the resulting
 *     token to the platform. Idempotent and safe to call on every mount.
 *   - {@link unregisterFromRemotePush} — call from the logout path BEFORE the
 *     session cookie is cleared (see `stores/auth-store.ts`) so the platform
 *     delete is authenticated. Removes the token for the bound assistant.
 *   - Tap routing — a `pushNotificationActionPerformed` listener publishes
 *     `deeplink.openThread` when the tapped notification carries a
 *     conversation id.
 *
 * iOS-only and best-effort: no-ops on Electron, desktop browsers, and Android
 * (no native Capacitor Android shell ships today); registration/delete failures
 * are reported to Sentry but never thrown into the app lifecycle.
 *
 * Per `docs/CAPACITOR.md`, the `@capacitor/*` plugins are destructured inline
 * at each call site — never returned through an `async` boundary — because the
 * plugin Proxy's `.then` trap would hang the awaiting caller forever.
 */

import { Capacitor } from "@capacitor/core";

import {
  assistantsPushTokensDelete,
  assistantsPushTokensUpsert,
} from "@/generated/api/sdk.gen";
import type { ApnsEnvironmentEnum } from "@/generated/api/types.gen";
import { publish } from "@/lib/event-bus";
import { captureError } from "@/lib/sentry/capture-error";
import { isNativePlatform } from "@/runtime/native-auth";
import { createStorageAccessor } from "@/utils/typed-storage";

/**
 * Bundle-id suffix that maps to the development APNs entitlement. The dev Xcode
 * config (`clients/ios/App/App/Config/App-Dev.xcconfig`) signs with
 * `App-Dev.entitlements` (`aps-environment = development`) and ships the `.dev`
 * bundle id; production and staging both sign with `App.entitlements`
 * (`aps-environment = production`). APNs rejects a token minted under one
 * environment if dispatched against the other, so the platform stores the
 * environment alongside the token and the value must match the running build.
 */
const DEV_BUNDLE_SUFFIX = ".dev";

/** Token registration we last upserted, retained so logout can delete it. */
interface RegisteredToken {
  token: string;
  bundleId: string;
  assistantId: string;
}

function parseRegisteredToken(raw: string): RegisteredToken | null {
  const value = JSON.parse(raw) as Partial<RegisteredToken>;
  if (
    typeof value.token === "string" &&
    typeof value.bundleId === "string" &&
    typeof value.assistantId === "string"
  ) {
    return {
      token: value.token,
      bundleId: value.bundleId,
      assistantId: value.assistantId,
    };
  }
  return null;
}

/**
 * The last successfully-upserted registration, persisted to user-scoped
 * storage. Module memory alone is insufficient: the WebView/app process can
 * reload (dropping `lastRegistered`) before `usePushRegistration` re-runs, and
 * `/logout` is a standalone route outside `RootLayout` — so logout could fire
 * with empty module state and skip the platform DELETE, leaving a signed-out
 * device still receiving remote pushes. The `vellum:` (user) scope is cleared
 * by the logout storage sweep, and we also remove it explicitly after delete.
 *
 * The stored value is a device push-routing registration (APNs destination
 * token + bundle + assistant), not auth/session material — losing it to XSS
 * does not grant access to anything, so JS-readable storage is appropriate
 * here (unlike session tokens, which must stay in HttpOnly cookies).
 */
const persistedRegistration = createStorageAccessor<RegisteredToken | null>({
  key: "vellum:push_registration",
  scope: "user",
  parse: parseRegisteredToken,
  serialize: JSON.stringify,
  fallback: null,
});

let listenersRegistered = false;
let currentAssistantId: string | null = null;
let lastRegistered: RegisteredToken | null = null;
const pendingUpserts = new Set<Promise<void>>();

/**
 * Track every in-flight upsert so logout can await all of them before
 * concluding there is nothing to delete. Without this, a `registration` event
 * whose `upsertToken` is still mid-POST when logout fires would leave
 * `lastRegistered` unset — the DELETE would be skipped while the upsert still
 * succeeds, leaving a signed-out device registered. A set (not a single
 * promise) is required because concurrent upserts can overlap — e.g. an
 * assistant switch starts a manual re-upsert and `register()` re-emits the
 * cached token — and awaiting only the latest would let an earlier, slower
 * upsert re-register the token after the delete.
 */
function trackUpsert(upsert: Promise<void>): void {
  pendingUpserts.add(upsert);
  void upsert.finally(() => {
    pendingUpserts.delete(upsert);
  });
}

/**
 * True only on the native Capacitor iOS runtime.
 *
 * APNs remote push is a native-only capability: a device token only exists
 * inside the iOS app process, there is no web/Electron equivalent, and the
 * daemon's `platform` channel exclusively targets iOS device tokens. This is
 * not a "present but broken" web API — there is nothing to feature-detect — so
 * a platform short-circuit is the correct guard. Android is excluded because no
 * native Capacitor Android shell ships today; revisit this guard if one does.
 */
export function isRemotePushSupported(): boolean {
  return isNativePlatform() && Capacitor.getPlatform() === "ios";
}

/** Map the running build's bundle id to its APNs entitlement environment. */
function resolveApnsEnvironment(bundleId: string): ApnsEnvironmentEnum {
  return bundleId.endsWith(DEV_BUNDLE_SUFFIX) ? "development" : "production";
}

/**
 * Upsert a freshly-minted APNs token to the platform for the given assistant.
 * Best-effort: a non-2xx response or thrown error is reported and swallowed.
 */
async function upsertToken(token: string, assistantId: string): Promise<void> {
  try {
    // `@capacitor/app` is a plugin Proxy — destructure inline (see CAPACITOR.md).
    const { App } = await import("@capacitor/app");
    const { id: bundleId } = await App.getInfo();

    const result = await assistantsPushTokensUpsert({
      path: { assistant_id: assistantId },
      body: {
        token,
        platform: "ios",
        bundle_id: bundleId,
        apns_environment: resolveApnsEnvironment(bundleId),
      },
      throwOnError: false,
    });

    if (result.error) {
      captureError(result.error, {
        context: "push_registration_upsert",
        level: "warning",
        bestEffort: true,
      });
      return;
    }

    lastRegistered = { token, bundleId, assistantId };
    persistedRegistration.save(lastRegistered);
  } catch (err) {
    captureError(err, {
      context: "push_registration_upsert",
      level: "warning",
      bestEffort: true,
    });
  }
}

/**
 * Conversation id a tapped push routes to: `data.deep_link.conversationId`
 * (daemon `deep_link_metadata`, relayed by the platform into the APNs
 * payload), falling back to a top-level `conversationId`. Undefined for
 * absent/malformed shapes — the tap then just foregrounds the app.
 */
export function extractPushConversationId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  const deepLink = record.deep_link;
  if (typeof deepLink === "object" && deepLink !== null) {
    const conversationId = (deepLink as Record<string, unknown>).conversationId;
    if (typeof conversationId === "string") {
      return conversationId;
    }
  }
  return typeof record.conversationId === "string"
    ? record.conversationId
    : undefined;
}

/**
 * Register the APNs `registration` / `registrationError` / tap listeners
 * exactly once. The `registration` handler upserts the token under whichever
 * assistant is current when iOS delivers it (iOS may emit the token
 * asynchronously, and re-emits the cached token on subsequent `register()`
 * calls).
 */
async function ensureListeners(): Promise<void> {
  if (listenersRegistered) return;
  listenersRegistered = true;
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    await PushNotifications.addListener("registration", (token) => {
      const assistantId = currentAssistantId;
      if (!assistantId) return;
      trackUpsert(upsertToken(token.value, assistantId));
    });
    await PushNotifications.addListener("registrationError", (err) => {
      captureError(err, {
        context: "push_registration_apns",
        level: "warning",
      });
    });
    await PushNotifications.addListener(
      "pushNotificationActionPerformed",
      (action) => {
        const conversationId = extractPushConversationId(
          action.notification.data,
        );
        if (conversationId) {
          publish("deeplink.openThread", { threadId: conversationId });
        }
      },
    );
  } catch (err) {
    // Allow a later call to retry listener registration.
    listenersRegistered = false;
    captureError(err, {
      context: "push_registration_listeners",
      level: "warning",
    });
  }
}

/**
 * Request notification permission, register for APNs, and upsert the resulting
 * device token to the platform for `assistantId`. No-ops off native iOS.
 *
 * Safe to call repeatedly (e.g. on every mount or assistant switch): iOS shows
 * the permission prompt at most once, `register()` re-emits the cached token,
 * and the listener re-upserts it. The same `UNUserNotificationCenter`
 * authorization backs the local-notification path, so this does not introduce a
 * second OS prompt.
 */
export async function registerForRemotePush(
  assistantId: string,
): Promise<void> {
  if (!isRemotePushSupported()) return;
  currentAssistantId = assistantId;

  // If iOS already handed us a token for this device under a different
  // assistant, re-upsert it now rather than waiting for another registration
  // event (which only fires again on the next `register()`).
  if (lastRegistered && lastRegistered.assistantId !== assistantId) {
    trackUpsert(upsertToken(lastRegistered.token, assistantId));
  }

  try {
    // `@capacitor/push-notifications` is a plugin Proxy — destructure inline.
    const { PushNotifications } = await import("@capacitor/push-notifications");
    await ensureListeners();
    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== "granted") return;
    await PushNotifications.register();
  } catch (err) {
    captureError(err, {
      context: "push_registration_register",
      level: "warning",
    });
  }
}

/**
 * Delete the last-registered device token from the platform. Call this from the
 * logout flow BEFORE the session cookie is cleared so the request is
 * authenticated (the platform delete is keyed on the still-valid session).
 *
 * Best-effort and idempotent: no-ops when nothing was registered or off native
 * iOS, and reports (does not throw) delete failures.
 */
export async function unregisterFromRemotePush(): Promise<void> {
  // Stop new registration events from upserting, then wait for any upsert
  // already in flight so we don't miss a token that is about to be registered
  // server-side. Logout awaits this function before clearing the session.
  currentAssistantId = null;
  // Drain in a loop: awaiting a batch can let a concurrent upsert finish and a
  // straggler get added. New upserts can only originate from a `registration`
  // event, which now no-ops (currentAssistantId is null), so this terminates.
  while (pendingUpserts.size > 0) {
    await Promise.allSettled([...pendingUpserts]);
  }

  // Fall back to persisted storage: a process reload before re-registration
  // leaves `lastRegistered` null even though a token is still registered.
  const registered = lastRegistered ?? persistedRegistration.load();
  lastRegistered = null;
  persistedRegistration.remove();

  if (!registered || !isRemotePushSupported()) return;

  try {
    const result = await assistantsPushTokensDelete({
      path: { assistant_id: registered.assistantId, token: registered.token },
      query: { bundle_id: registered.bundleId },
      throwOnError: false,
    });
    // `throwOnError: false` surfaces 4xx/5xx in `result.error`; a silently
    // failed delete leaves the token registered, so report it rather than
    // treating the unregister as complete.
    if (result.error) {
      captureError(result.error, {
        context: "push_registration_delete",
        level: "warning",
        bestEffort: true,
        extra: {
          assistantId: registered.assistantId,
          bundleId: registered.bundleId,
        },
      });
    }
  } catch (err) {
    captureError(err, {
      context: "push_registration_delete",
      level: "warning",
      bestEffort: true,
    });
  }
}

/** Test-only: reset module + persisted state between cases. */
export function __resetPushRegistrationStateForTests(): void {
  listenersRegistered = false;
  currentAssistantId = null;
  lastRegistered = null;
  pendingUpserts.clear();
  persistedRegistration.remove();
}
