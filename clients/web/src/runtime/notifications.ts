/**
 * Local notification bridge for `notification_intent` events from the
 * daemon. Mirrors the macOS client's
 * `AppDelegate+Notifications.postNotificationIntent()` so users get a
 * native banner on Capacitor mobile, an `electron.Notification` on the
 * Electron desktop shell, or a system Notification on desktop browsers
 * without any server-side push infrastructure.
 *
 * Three host paths:
 *
 *   1. **Electron** — routes through `window.vellum.notifications.show()`
 *      which IPC-invokes `electron.Notification` in the main process.
 *      Supports macOS action buttons (View, Approve/Reject, Open) that
 *      the Web Notification API cannot provide.
 *   2. **Capacitor mobile** - schedules through
 *      `@capacitor/local-notifications`.
 *   3. **Desktop browser** — falls back to the Web Notification API.
 *
 * Key tradeoff vs. APNs remote push: local notifications only fire while
 * the app's JS runtime is alive (foreground or recently backgrounded on
 * iOS, tab open on desktop). A user whose Capacitor iOS app has been
 * suspended for hours will not receive new notifications. For true
 * background delivery we need APNs or FCM, tracked in LUM-1159.
 */

import {
  LocalNotifications,
  type LocalNotificationSchema,
} from "@capacitor/local-notifications";
import type { PushNotificationSchema } from "@capacitor/push-notifications";

import { notificationintentresultPost } from "@/generated/daemon/sdk.gen";
import type { NotificationintentresultPostData } from "@/generated/daemon/types.gen";
import {
  ANDROID_ALERTS_CHANNEL_ID,
  ensureAndroidAlertsChannel,
} from "@/runtime/android-notification-channels";
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform } from "@/runtime/native-auth";
import { isNativeAndroid } from "@/runtime/platform-detection";
import {
  extractPushConversationId,
  hasSessionConfirmedRemotePushRegistration,
} from "@/runtime/push-registration";

/**
 * Payload stored alongside each native notification so the tap handler can
 * deep-link back to the originating conversation. Kept intentionally small —
 * iOS truncates `userInfo` payloads and we don't need the full daemon event.
 */
export interface NotificationTapPayload {
  conversationId?: string;
  sourceEventName: string;
  deliveryId?: string;
}

/** Current notification permission status, cached after first resolution. */
type PermissionState = "granted" | "denied" | "prompt" | "unsupported";

let cachedPermission: PermissionState | null = null;
let pendingPermissionRequest: Promise<PermissionState> | null = null;
let tapListenersRegistered = false;
let tapHandler: ((payload: NotificationTapPayload) => void) | null = null;
const recentNativeDeliveryIds = new Set<string>();
const nativeDeliveryPromises = new Map<string, Promise<void>>();
const MAX_RECENT_DELIVERY_IDS = 128;

/**
 * True when the current host supports system notifications at all (Electron
 * main-process Notification, Capacitor LocalNotifications, or the browser
 * Notification API).
 */
export function isNotificationsSupported(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (isElectron()) {
    return !!window.vellum?.notifications;
  }
  if (isNativePlatform()) {
    return true;
  }
  return "Notification" in window;
}

async function checkNativePermission(): Promise<PermissionState> {
  try {
    const { display } = await LocalNotifications.checkPermissions();
    if (display === "granted") {
      return "granted";
    }
    if (display === "denied") {
      return "denied";
    }
    return "prompt";
  } catch {
    return "unsupported";
  }
}

function checkBrowserPermission(): PermissionState {
  if (typeof Notification === "undefined") {
    return "unsupported";
  }
  switch (Notification.permission) {
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    default:
      return "prompt";
  }
}

async function requestNativePermission(): Promise<PermissionState> {
  try {
    const { display } = await LocalNotifications.requestPermissions();
    if (display === "granted") {
      return "granted";
    }
    if (display === "denied") {
      return "denied";
    }
    return "prompt";
  } catch {
    return "unsupported";
  }
}

async function requestBrowserPermission(): Promise<PermissionState> {
  if (typeof Notification === "undefined") {
    return "unsupported";
  }
  const result = await Notification.requestPermission();
  if (result === "granted") {
    return "granted";
  }
  if (result === "denied") {
    return "denied";
  }
  return "prompt";
}

/**
 * Resolve the current permission state without prompting the user.
 */
export async function getNotificationPermission(): Promise<PermissionState> {
  if (cachedPermission) {
    return cachedPermission;
  }
  const state = isNativePlatform()
    ? await checkNativePermission()
    : checkBrowserPermission();
  cachedPermission = state;
  return state;
}

export async function refreshNotificationPermission(): Promise<PermissionState> {
  cachedPermission = null;
  return getNotificationPermission();
}

/**
 * Trigger the OS-level permission prompt the first time we receive a
 * notification-worthy event. Subsequent denials are cached — we never
 * re-prompt (both iOS and browsers ignore repeat prompts anyway, but the
 * cache avoids wasted round-trips).
 *
 * The prompt is memoized as an in-flight promise rather than latched behind
 * a boolean, because the user can take arbitrarily long to answer it — they
 * are, by construction, in another app when the first intent lands. Every
 * intent that arrives during that window awaits the same prompt and posts
 * once it resolves; a boolean latch would instead resolve them all to
 * `"prompt"`, drop their banners, and ack the daemon with an authorization
 * denial that never happened.
 */
export async function ensureNotificationPermission(): Promise<PermissionState> {
  const current = await getNotificationPermission();
  if (current !== "prompt") {
    return current;
  }
  pendingPermissionRequest ??= requestPermissionOnce();
  return pendingPermissionRequest;
}

/**
 * Issue the permission request and cache its outcome. Kept memoized for the
 * life of the session (never cleared): a resolved grant or denial is served
 * from `cachedPermission` on the next call, and an unanswered or throwing
 * prompt resolves to `"prompt"` without re-prompting.
 */
async function requestPermissionOnce(): Promise<PermissionState> {
  try {
    const result = isNativePlatform()
      ? await requestNativePermission()
      : await requestBrowserPermission();
    cachedPermission = result;
    return result;
  } catch {
    // `Notification.requestPermission()` throws on older browsers and when
    // the page lacks the activation some engines require. Treat it as
    // unanswered rather than denied.
    return "prompt";
  }
}

async function registerTapListeners(): Promise<void> {
  if (tapListenersRegistered) {
    return;
  }
  tapListenersRegistered = true;

  // Electron path: subscribe to main-process notification action events.
  // Converts the richer `NotificationActionEvent` into the common
  // `NotificationTapPayload` so the same `tapHandler` is invoked
  // regardless of platform. The listener is permanent (app lifetime).
  if (isElectron() && window.vellum?.notifications) {
    window.vellum.notifications.onAction((event) => {
      if (!tapHandler) {
        return;
      }
      tapHandler({
        conversationId: event.conversationId,
        sourceEventName: `electron:${event.category}:${event.kind}`,
        deliveryId: event.deliveryId,
      });
    });
    return;
  }

  if (!isNativePlatform()) {
    return;
  }
  try {
    await LocalNotifications.addListener(
      "localNotificationActionPerformed",
      (action) => {
        const extra = action.notification.extra as
          NotificationTapPayload | undefined;
        if (extra && tapHandler) {
          tapHandler(extra);
        }
      },
    );
  } catch {
    // Listener registration is best-effort — a failure here means taps
    // won't deep-link, but banners will still fire.
  }
}

/**
 * Set (or replace) the handler invoked when the user taps a notification
 * or presses an action button. Safe to call on every render — the
 * underlying platform listener (Capacitor, Electron, or browser) is
 * registered only once and the handler reference is swapped in place so
 * closures always see the latest callback.
 */
export function setNotificationTapHandler(
  handler: (payload: NotificationTapPayload) => void,
): void {
  tapHandler = handler;
  void registerTapListeners();
}

/**
 * Notifications API requires a 32-bit signed integer ID. Hash the daemon's
 * string deliveryId (or title+body if absent) into that range so repeat
 * deliveries of the same notification replace rather than stack.
 */
function toNotificationId(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 0x7fffffff;
}

async function scheduleNativeDelivery(
  deliveryId: string,
  notification: LocalNotificationSchema,
): Promise<void> {
  if (recentNativeDeliveryIds.has(deliveryId)) {
    return;
  }
  let pending = nativeDeliveryPromises.get(deliveryId);
  if (!pending) {
    pending = (async () => {
      try {
        try {
          await ensureAndroidAlertsChannel();
          await LocalNotifications.schedule({ notifications: [notification] });
        } catch {
          await ensureAndroidAlertsChannel();
          await LocalNotifications.schedule({ notifications: [notification] });
        }
        recentNativeDeliveryIds.add(deliveryId);
        if (recentNativeDeliveryIds.size > MAX_RECENT_DELIVERY_IDS) {
          const oldest = recentNativeDeliveryIds.values().next().value;
          if (oldest) {
            recentNativeDeliveryIds.delete(oldest);
          }
        }
      } finally {
        nativeDeliveryPromises.delete(deliveryId);
      }
    })();
    nativeDeliveryPromises.set(deliveryId, pending);
  }
  await pending;
}

/**
 * Resolve the conversation this notification should deep-link to.
 *
 * Daemon-side notification emitters set `deepLinkMetadata.conversationId`
 * explicitly in `broadcaster.ts` (the only production construction site
 * for vellum-channel deep links). The web client receives notifications
 * only on the vellum channel, so `conversationId` is always present in
 * `deepLinkMetadata` for any notification that reaches this code path.
 */
export function extractConversationId(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata) {
    return undefined;
  }
  const { conversationId } = metadata;
  if (typeof conversationId === "string" && conversationId.length > 0) {
    return conversationId;
  }
  return undefined;
}

export interface PostLocalNotificationArgs {
  title: string;
  body: string;
  sourceEventName: string;
  deliveryId?: string;
  correlationId?: string;
  deepLinkMetadata?: Record<string, unknown>;
  /**
   * When set alongside `deliveryId`, `postLocalNotification` sends a
   * `notification_intent_result` ack to the daemon after scheduling the
   * banner (or on failure) so delivery audit trails stay consistent with
   * the macOS client. Callers for skip paths (guardian-scoped,
   * focused-conversation, etc.) should invoke {@link sendNotificationIntentAck}
   * directly with `success=true`.
   */
  assistantId?: string;
  /**
   * True when the daemon confirmed the platform (APNs) channel accepted a
   * remote push for this delivery. A native app that is hidden at intent
   * arrival with a session-confirmed push registration skips the local
   * banner so the remote push is the only one.
   */
  remotePushDispatched?: boolean;
  /** Native platforms that accepted this delivery for remote push. */
  remotePushPlatforms?: ("ios" | "android")[];
}

/**
 * POST `notification_intent_result` to the daemon via the cloud platform's
 * runtime proxy. Mirrors the macOS client's
 * `NotificationClient.sendIntentResult` (which POSTs to the gateway) so the
 * daemon's `notificationDeliveries` table records client-side outcomes for
 * every delivery, regardless of the platform that handled it. Best-effort:
 * network errors are swallowed because the banner UX has already happened
 * and retrying the ack would not change user-visible behavior.
 */
export async function sendNotificationIntentAck(
  assistantId: string,
  deliveryId: string,
  success: boolean,
  errorMessage?: string,
): Promise<void> {
  try {
    const body: NotificationintentresultPostData["body"] = {
      deliveryId,
      success,
    };
    if (errorMessage) {
      body.errorMessage = errorMessage;
    }
    await notificationintentresultPost({
      path: { assistant_id: assistantId },
      body,
      throwOnError: false,
    });
  } catch {
    // Ack is best-effort — never surface ack failures to the caller.
  }
}

/**
 * Display a native notification. On Capacitor iOS this schedules via
 * `UNUserNotificationCenter`; on desktop browsers it calls the Web
 * Notification API. No-ops silently when notifications are unsupported or
 * permission has been denied — callers should not need to branch.
 */
export async function postLocalNotification(
  args: PostLocalNotificationArgs,
): Promise<void> {
  if (!isNotificationsSupported()) {
    if (args.assistantId && args.deliveryId) {
      await sendNotificationIntentAck(
        args.assistantId,
        args.deliveryId,
        false,
        "Notifications not supported on this client",
      );
    }
    return;
  }

  // Electron path: route through the main-process bridge which uses
  // `electron.Notification` (supports macOS action buttons). Permission
  // is handled by the main process — we skip the renderer permission
  // dance entirely.
  if (isElectron() && window.vellum?.notifications) {
    let success = true;
    let errorMessage: string | undefined;
    try {
      const result = await window.vellum.notifications.show({
        category: "notificationIntent",
        title: args.title,
        body: args.body,
        deliveryId: args.deliveryId,
        conversationId: extractConversationId(args.deepLinkMetadata),
        deepLinkMetadata: args.deepLinkMetadata,
      });
      success = result.success;
      errorMessage = result.errorMessage;
    } catch (err) {
      success = false;
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    if (args.assistantId && args.deliveryId) {
      await sendNotificationIntentAck(
        args.assistantId,
        args.deliveryId,
        success,
        errorMessage,
      );
    }
    return;
  }

  // Snapshot before the awaits below: the remote-push dedup skip must see
  // visibility at intent arrival, not after an async native-bridge gap.
  const visibilityAtIntent = document.visibilityState;

  const permission = await ensureNotificationPermission();
  if (permission !== "granted") {
    if (args.assistantId && args.deliveryId) {
      await sendNotificationIntentAck(
        args.assistantId,
        args.deliveryId,
        false,
        "Notification authorization denied",
      );
    }
    return;
  }

  const conversationId = extractConversationId(args.deepLinkMetadata);
  const tapPayload: NotificationTapPayload = {
    conversationId,
    sourceEventName: args.sourceEventName,
    deliveryId: args.deliveryId,
  };

  let success = true;
  let errorMessage: string | undefined;

  if (isNativePlatform()) {
    // Foreground native pushes use a local banner. Hidden pushes use the OS
    // banner when this platform accepted the remote delivery, so the SSE path
    // skips its local copy in that case. The legacy APNs-only flag remains the
    // iOS fallback when an older assistant omits the platform list.
    //
    // Residual limitation: platform acceptance is an account-level outcome,
    // so on a multi-device account a token pruned mid-session can suppress
    // this banner while only another device received the push.
    const remotePushAccepted = args.remotePushPlatforms
      ? args.remotePushPlatforms.includes(isNativeAndroid() ? "android" : "ios")
      : !isNativeAndroid() && args.remotePushDispatched === true;
    if (
      remotePushAccepted &&
      args.assistantId !== undefined &&
      hasSessionConfirmedRemotePushRegistration(args.assistantId) &&
      visibilityAtIntent === "hidden"
    ) {
      if (args.deliveryId) {
        await sendNotificationIntentAck(
          args.assistantId,
          args.deliveryId,
          true,
        );
      }
      return;
    }

    const seed =
      args.correlationId ??
      args.deliveryId ??
      `${args.sourceEventName}:${args.title}:${args.body}`;
    const notification: LocalNotificationSchema = {
      id: toNotificationId(seed),
      title: args.title,
      body: args.body,
      extra: tapPayload,
      ...(isNativeAndroid() ? { channelId: ANDROID_ALERTS_CHANNEL_ID } : {}),
    };
    try {
      const correlationId = args.correlationId ?? args.deliveryId;
      if (correlationId && isNativeAndroid()) {
        await scheduleNativeDelivery(correlationId, notification);
      } else {
        await ensureAndroidAlertsChannel();
        await LocalNotifications.schedule({ notifications: [notification] });
      }
    } catch (err) {
      // Never block the SSE loop on notification failures, but record the
      // outcome so the daemon's delivery audit trail reflects reality.
      success = false;
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  } else {
    // Desktop browser path. Mirror the native `toNotificationId` fallback —
    // `sourceEventName` alone is too coarse (two conversations both emitting
    // `chat.assistant_turn_complete` would replace each other on the
    // browser's single-tag lane), so include title + body in the seed to
    // keep distinct notifications distinct.
    const tag =
      args.deliveryId ?? `${args.sourceEventName}:${args.title}:${args.body}`;
    try {
      const n = new Notification(args.title, {
        body: args.body,
        tag,
        data: tapPayload,
      });
      n.onclick = () => {
        window.focus();
        if (tapHandler) {
          tapHandler(tapPayload);
        }
        n.close();
      };
    } catch (err) {
      // Notification constructor can throw on older browsers or when the
      // page has lost focus — record the failure but don't throw.
      success = false;
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  if (args.assistantId && args.deliveryId) {
    await sendNotificationIntentAck(
      args.assistantId,
      args.deliveryId,
      success,
      errorMessage,
    );
  }
}

export function postForegroundRemotePush(
  notification: PushNotificationSchema,
): void {
  if (!isNativeAndroid()) {
    return;
  }
  const data =
    typeof notification.data === "object" && notification.data !== null
      ? (notification.data as Record<string, unknown>)
      : {};
  const deliveryId =
    typeof data.delivery_id === "string" ? data.delivery_id : notification.id;
  const sourceEventName =
    typeof data.source_event_name === "string"
      ? data.source_event_name
      : "remote_push";
  const conversationId = extractPushConversationId(data);

  void postLocalNotification({
    title: notification.title ?? "Vellum",
    body: notification.body ?? "",
    sourceEventName,
    deliveryId,
    correlationId: deliveryId,
    deepLinkMetadata: conversationId ? { conversationId } : undefined,
  });
}

export function __resetNotificationsStateForTests(): void {
  cachedPermission = null;
  pendingPermissionRequest = null;
  tapListenersRegistered = false;
  tapHandler = null;
  recentNativeDeliveryIds.clear();
  nativeDeliveryPromises.clear();
}
