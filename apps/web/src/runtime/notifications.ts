/**
 * Local notification bridge for `notification_intent` events from the
 * daemon. Mirrors the macOS client's
 * `AppDelegate+Notifications.postNotificationIntent()` so users get a
 * native banner on Capacitor iOS and a system Notification on desktop
 * browsers without any server-side push infrastructure.
 *
 * Key tradeoff vs. APNs remote push: local notifications only fire while
 * the app's JS runtime is alive (foreground or recently backgrounded on
 * iOS, tab open on desktop). A user whose Capacitor iOS app has been
 * suspended for hours will not receive new notifications. For true
 * background delivery we need APNs, tracked in LUM-1159.
 */

import {
  LocalNotifications,
  type LocalNotificationSchema,
} from "@capacitor/local-notifications";

import { client } from "@/generated/api/client.gen.js";
import "@/lib/api-client.js";
import { isNativePlatform } from "@/runtime/native-auth.js";

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

/**
 * Payload stored alongside each native notification so the tap handler can
 * deep-link back to the originating conversation. Kept intentionally small —
 * iOS truncates `userInfo` payloads and we don't need the full daemon event.
 */
export interface NotificationTapPayload {
  conversationKey?: string;
  sourceEventName: string;
  deliveryId?: string;
}

/** Current notification permission status, cached after first resolution. */
type PermissionState = "granted" | "denied" | "prompt" | "unsupported";

let cachedPermission: PermissionState | null = null;
let permissionPromptIssued = false;
let tapListenersRegistered = false;
let tapHandler: ((payload: NotificationTapPayload) => void) | null = null;

/**
 * True when the current host supports system notifications at all (either
 * via Capacitor LocalNotifications or the browser Notification API).
 */
export function isNotificationsSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (isNativePlatform()) return true;
  return "Notification" in window;
}

async function checkNativePermission(): Promise<PermissionState> {
  try {
    const { display } = await LocalNotifications.checkPermissions();
    if (display === "granted") return "granted";
    if (display === "denied") return "denied";
    return "prompt";
  } catch {
    return "unsupported";
  }
}

function checkBrowserPermission(): PermissionState {
  if (typeof Notification === "undefined") return "unsupported";
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
    if (display === "granted") return "granted";
    if (display === "denied") return "denied";
    return "prompt";
  } catch {
    return "unsupported";
  }
}

async function requestBrowserPermission(): Promise<PermissionState> {
  if (typeof Notification === "undefined") return "unsupported";
  const result = await Notification.requestPermission();
  if (result === "granted") return "granted";
  if (result === "denied") return "denied";
  return "prompt";
}

/**
 * Resolve the current permission state without prompting the user.
 */
export async function getNotificationPermission(): Promise<PermissionState> {
  if (cachedPermission) return cachedPermission;
  const state = isNativePlatform()
    ? await checkNativePermission()
    : checkBrowserPermission();
  cachedPermission = state;
  return state;
}

/**
 * Trigger the OS-level permission prompt the first time we receive a
 * notification-worthy event. Subsequent denials are cached — we never
 * re-prompt (both iOS and browsers ignore repeat prompts anyway, but the
 * cache avoids wasted round-trips).
 */
export async function ensureNotificationPermission(): Promise<PermissionState> {
  const current = await getNotificationPermission();
  if (current !== "prompt") return current;
  if (permissionPromptIssued) return current;
  permissionPromptIssued = true;
  const result = isNativePlatform()
    ? await requestNativePermission()
    : await requestBrowserPermission();
  cachedPermission = result;
  return result;
}

async function registerTapListeners(): Promise<void> {
  if (tapListenersRegistered) return;
  tapListenersRegistered = true;
  if (!isNativePlatform()) return;
  try {
    await LocalNotifications.addListener(
      "localNotificationActionPerformed",
      (action) => {
        const extra = action.notification.extra as
          | NotificationTapPayload
          | undefined;
        if (extra && tapHandler) tapHandler(extra);
      },
    );
  } catch {
    // Listener registration is best-effort — a failure here means taps
    // won't deep-link, but banners will still fire.
  }
}

/**
 * Set (or replace) the handler invoked when the user taps a notification.
 * Safe to call on every render — the underlying Capacitor listener is
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

/**
 * Resolve the conversation this notification should deep-link to. The daemon
 * emits either `conversationId` (the internal daemon ID) or `conversationKey`
 * (the key the web sidebar indexes by) in `deepLinkMetadata`; for this client
 * both are the same value (the web app has no notion of a separate
 * conversationId — see the comment in `parseAssistantEvent` for
 * `conversation_title_updated`). Accept whichever one the upstream provides
 * so tap navigation and active-conversation suppression stay consistent.
 */
export function extractConversationKey(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata) return undefined;
  const { conversationId, conversationKey } = metadata;
  if (typeof conversationKey === "string" && conversationKey.length > 0) {
    return conversationKey;
  }
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
    const body: Record<string, unknown> = { deliveryId, success };
    if (errorMessage) body.errorMessage = errorMessage;
    // The daemon's notification route (`v1/notification-intent-result`) is not
    // a first-class resource in the cloud OpenAPI schema — it reaches the pod
    // through `RuntimeProxyView`, which transparently strips the
    // `/v1/assistants/{id}/` prefix. Use the HeyAPI client anyway so auth,
    // base URL, and credentials stay consistent with `submitConfirmation` and
    // friends.
    await client.post<unknown, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/notification-intent-result/",
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

  const conversationKey = extractConversationKey(args.deepLinkMetadata);
  const tapPayload: NotificationTapPayload = {
    conversationKey,
    sourceEventName: args.sourceEventName,
    deliveryId: args.deliveryId,
  };

  let success = true;
  let errorMessage: string | undefined;

  if (isNativePlatform()) {
    const seed =
      args.deliveryId ??
      `${args.sourceEventName}:${args.title}:${args.body}`;
    const notification: LocalNotificationSchema = {
      id: toNotificationId(seed),
      title: args.title,
      body: args.body,
      extra: tapPayload,
    };
    try {
      await LocalNotifications.schedule({ notifications: [notification] });
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
      args.deliveryId ??
      `${args.sourceEventName}:${args.title}:${args.body}`;
    try {
      const n = new Notification(args.title, {
        body: args.body,
        tag,
        data: tapPayload,
      });
      n.onclick = () => {
        window.focus();
        if (tapHandler) tapHandler(tapPayload);
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
