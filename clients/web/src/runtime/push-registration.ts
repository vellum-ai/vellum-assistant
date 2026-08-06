/**
 * Native remote-push token registration and tap routing for the Capacitor
 * mobile apps.
 *
 * The daemon's `platform` notification channel POSTs background notifications
 * (reminders, activity completions, etc.) to the Vellum platform's
 * `/v1/assistants/{id}/push/dispatch/` endpoint, which fans them out to every
 * native device token registered for the bound user. This module is the missing
 * client half: it asks the OS for an APNs or FCM token via
 * `@capacitor/push-notifications`, then upserts that token to the platform.
 *
 * Why this matters for reminders specifically: the in-app local-notification
 * path (`runtime/notifications.ts`) only fires while the JS runtime is alive
 * (foreground / recently-backgrounded). Scheduled reminders fire while the app
 * is backgrounded or suspended, so native remote push is the only path that can
 * reach the device. (LUM-1159)
 *
 * Lifecycle:
 *   - {@link registerForRemotePush} — call once an assistant is active. Requests
 *     notification permission, registers for APNs or FCM, and upserts the resulting
 *     token to the platform. Idempotent and safe to call on every mount.
 *   - {@link unregisterFromRemotePush} — call from the logout path BEFORE the
 *     session cookie is cleared (see `stores/auth-store.ts`) so the platform
 *     delete is authenticated. Removes the token for the bound assistant.
 *   - Tap routing — a `pushNotificationActionPerformed` listener publishes
 *     `deeplink.openThread` when the tapped notification carries a
 *     conversation id.
 *
 * Native-only and best-effort: no-ops on Electron and browsers;
 * registration/delete failures are reported to Sentry but never thrown into
 * the app lifecycle.
 *
 * The upserted row's `apns_environment` tag is resolved by
 * `runtime/apns-environment.ts`; see its docblock for the rationale.
 *
 * Per `docs/CAPACITOR.md`, the `@capacitor/*` plugins are destructured inline
 * at each call site — never returned through an `async` boundary — because the
 * plugin Proxy's `.then` trap would hang the awaiting caller forever.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import type { PushNotificationSchema } from "@capacitor/push-notifications";

import {
  assistantsPushTokensDelete,
  assistantsPushTokensUpsert,
} from "@/generated/api/sdk.gen";
import { publish } from "@/lib/event-bus";
import { captureError } from "@/lib/sentry/capture-error";
import { ensureAndroidAlertsChannel } from "@/runtime/android-notification-channels";
import { resolveSignedApnsEnvironment } from "@/runtime/apns-environment";
import { isNativePlatform } from "@/runtime/native-auth";
import { createStorageAccessor } from "@/utils/typed-storage";

/** Token registration we last upserted, retained so logout can delete it. */
interface RegisteredToken {
  token: string;
  bundleId: string;
  assistantId: string;
}

interface AndroidPushRegistrationPlugin {
  register(): Promise<void>;
  unregister(): Promise<void>;
}

const ANDROID_PUSH_REGISTRATION_PLUGIN = "AndroidPushRegistration";
const AndroidPushRegistration = registerPlugin<AndroidPushRegistrationPlugin>(
  ANDROID_PUSH_REGISTRATION_PLUGIN,
);

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
 * The stored value is a device push-routing registration (native destination
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
let foregroundPushHandler: ((push: PushNotificationSchema) => void) | null =
  null;
const pendingUpserts = new Set<Promise<void>>();
let androidUpsertQueue = Promise.resolve();

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

function queueUpsert(token: string, assistantId: string): void {
  const upsert =
    Capacitor.getPlatform() === "android"
      ? (androidUpsertQueue = androidUpsertQueue.then(() =>
          upsertToken(token, assistantId),
        ))
      : upsertToken(token, assistantId);
  trackUpsert(upsert);
}

/**
 * True only on a native Capacitor mobile runtime.
 *
 * A device push token exists only inside the iOS or Android app process. There
 * is no browser or Electron equivalent.
 */
export function isRemotePushSupported(): boolean {
  const platform = Capacitor.getPlatform();
  return isNativePlatform() && (platform === "ios" || platform === "android");
}

/**
 * Upsert a freshly-minted native token to the platform for the given assistant.
 * Best-effort: a non-2xx response or thrown error is reported and swallowed.
 */
async function upsertToken(token: string, assistantId: string): Promise<void> {
  try {
    // `@capacitor/app` is a plugin Proxy — destructure inline (see CAPACITOR.md).
    const { App } = await import("@capacitor/app");
    const { id: bundleId } = await App.getInfo();
    const platform = Capacitor.getPlatform();
    const body =
      platform === "android"
        ? {
            token,
            platform: "android" as const,
            bundle_id: bundleId,
          }
        : {
            token,
            platform: "ios" as const,
            bundle_id: bundleId,
            apns_environment: await resolveSignedApnsEnvironment(bundleId),
          };

    const result = await assistantsPushTokensUpsert({
      path: { assistant_id: assistantId },
      body,
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

    const previous = lastRegistered ?? persistedRegistration.load();
    lastRegistered = { token, bundleId, assistantId };
    persistedRegistration.save(lastRegistered);
    if (
      previous &&
      previous.bundleId === bundleId &&
      previous.token !== token &&
      platform === "android"
    ) {
      await deleteRegisteredToken(previous);
    }
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
  let deepLink = record.deep_link;
  if (typeof deepLink === "string") {
    try {
      deepLink = JSON.parse(deepLink) as unknown;
    } catch {
      deepLink = null;
    }
  }
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

async function deleteRegisteredToken(
  registered: RegisteredToken,
): Promise<void> {
  const result = await assistantsPushTokensDelete({
    path: { assistant_id: registered.assistantId, token: registered.token },
    query: { bundle_id: registered.bundleId },
    throwOnError: false,
  });
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
}

export function setForegroundPushHandler(
  handler: ((push: PushNotificationSchema) => void) | null,
): void {
  foregroundPushHandler = handler;
}

/**
 * Register the native `registration` / `registrationError` / tap listeners
 * exactly once. The `registration` handler upserts the token under whichever
 * assistant is current when the OS delivers it (the OS may emit the token
 * asynchronously, and re-emits the cached token on subsequent `register()`
 * calls).
 */
async function ensureListeners(): Promise<void> {
  if (listenersRegistered) {
    return;
  }
  listenersRegistered = true;
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    await PushNotifications.addListener("registration", (token) => {
      const assistantId = currentAssistantId;
      if (!assistantId) {
        return;
      }
      queueUpsert(token.value, assistantId);
    });
    await PushNotifications.addListener("registrationError", (err) => {
      captureError(err, {
        context: "push_registration_native",
        level: "warning",
      });
    });
    if (Capacitor.getPlatform() === "android") {
      await PushNotifications.addListener(
        "pushNotificationReceived",
        (notification) => foregroundPushHandler?.(notification),
      );
    }
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
 * Request notification permission, register with APNs or FCM, and upsert the
 * resulting device token to the platform for `assistantId`.
 *
 * Safe to call repeatedly (e.g. on every mount or assistant switch): the OS
 * shows the permission prompt at most once, `register()` re-emits the cached token,
 * and the listener re-upserts it. The same `UNUserNotificationCenter`
 * authorization backs the local-notification path, so this does not introduce a
 * second OS prompt.
 */
export async function registerForRemotePush(
  assistantId: string,
): Promise<void> {
  if (!isRemotePushSupported()) {
    return;
  }
  const isAndroid = Capacitor.getPlatform() === "android";
  currentAssistantId = assistantId;

  // If iOS already handed us a token for this device under a different
  // assistant, re-upsert it now rather than waiting for another registration
  // event (which only fires again on the next `register()`).
  if (lastRegistered && lastRegistered.assistantId !== assistantId) {
    queueUpsert(lastRegistered.token, assistantId);
  }

  try {
    // `@capacitor/push-notifications` is a plugin Proxy — destructure inline.
    const { PushNotifications } = await import("@capacitor/push-notifications");
    await ensureListeners();
    if (
      isAndroid &&
      !Capacitor.isPluginAvailable(ANDROID_PUSH_REGISTRATION_PLUGIN)
    ) {
      return;
    }
    await ensureAndroidAlertsChannel();
    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== "granted") {
      return;
    }
    if (isAndroid) {
      await AndroidPushRegistration.register();
    } else {
      await PushNotifications.register();
    }
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
 * mobile, and reports (does not throw) delete failures.
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

  // Module memory, falling back to persisted storage: a process reload wipes
  // `lastRegistered` while the token stays registered server-side.
  const registered = lastRegistered ?? persistedRegistration.load();
  lastRegistered = null;
  persistedRegistration.remove();

  if (!isRemotePushSupported()) {
    return;
  }

  if (registered) {
    try {
      await deleteRegisteredToken(registered);
    } catch (err) {
      captureError(err, {
        context: "push_registration_delete",
        level: "warning",
        bestEffort: true,
      });
    }
  }

  if (Capacitor.getPlatform() === "android") {
    try {
      if (Capacitor.isPluginAvailable(ANDROID_PUSH_REGISTRATION_PLUGIN)) {
        await AndroidPushRegistration.unregister();
      }
    } catch (err) {
      captureError(err, {
        context: "push_registration_unregister",
        level: "warning",
      });
    }
  }
}

/**
 * True when this device holds a push registration for `assistantId` that was
 * confirmed in the current JS session (module-memory `lastRegistered`, set
 * only when an upsert succeeded after this process started).
 *
 * Deliberately ignores the persisted-storage registration: a record from an
 * earlier session only proves an upsert once succeeded, not that the platform
 * still holds a token row for this device (provider invalid-token responses
 * prune rows server-side). A session-confirmed upsert proves the platform
 * held a live token row for this device at mount time, which is the evidence
 * the remote-push banner dedup in `runtime/notifications.ts` needs before
 * suppressing a local banner. The logout path is different: deleting a
 * possibly-stale token is harmless, so `unregisterFromRemotePush` falls back
 * to the persisted registration.
 *
 * Pure state read, never touches Capacitor plugins, so it is safe to call
 * synchronously on any platform.
 */
export function hasSessionConfirmedRemotePushRegistration(
  assistantId: string,
): boolean {
  return lastRegistered?.assistantId === assistantId;
}

/** Test-only: reset module + persisted state between cases. */
export function __resetPushRegistrationStateForTests(): void {
  listenersRegistered = false;
  currentAssistantId = null;
  lastRegistered = null;
  foregroundPushHandler = null;
  pendingUpserts.clear();
  androidUpsertQueue = Promise.resolve();
  persistedRegistration.remove();
}
