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
import type {
  NotificationDeliveryResult,
  NotificationIdentity,
  ShowNotificationPayload,
} from "@vellumai/ipc-contract";

import { notificationintentresultPost } from "@/generated/daemon/sdk.gen";
import type { NotificationintentresultPostData } from "@/generated/daemon/types.gen";
import { t } from "@/i18n";
import {
  ANDROID_ALERTS_CHANNEL_ID,
  ensureAndroidAlertsChannel,
} from "@/runtime/android-notification-channels";
import {
  allowsLegacyAndroidNotificationFallback,
  postAndroidSenderNotification,
} from "@/runtime/android-sender-notification";
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform } from "@/runtime/native-auth";
import { getNotificationIdentitySnapshot } from "@/runtime/notification-avatar";
import {
  resolveNotificationSender,
  type OwnedNotificationName,
  type NotificationSenderResolution,
} from "@/runtime/notification-sender";
import {
  __resetNotificationTapsForTests,
  dispatchNotificationTap,
  registerNotificationTapHandler,
  type NotificationTapHandler,
  type NotificationTapPayload,
} from "@/runtime/notification-taps";
import {
  isNativeAndroid,
  isNativeIOS,
} from "@/runtime/platform-detection";
import {
  extractPushConversationId,
  extractScopedPushTapPayload,
  hasSessionConfirmedRemotePushRegistration,
} from "@/runtime/push-registration";
import {
  allowsLegacyNotificationFallback,
  postSenderNotification,
} from "@/runtime/sender-notification";
import { isVisibleToUser } from "@/runtime/window-attention";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useConversationStore } from "@/stores/conversation-store";
import { isConversationChatPath } from "@/utils/routes";

export type { NotificationTapPayload } from "@/runtime/notification-taps";

/**
 * Capacitor / APNs category for the "Go to Conversation" action. Must stay
 * aligned with `NotificationCategories.intentIdentifier` in the iOS shell and
 * `APNS_CONVERSATION_CATEGORY` on the platform APNs sender.
 */
export const NOTIFICATION_INTENT_ACTION_TYPE_ID = "notificationIntent";

/** Action id inside {@link NOTIFICATION_INTENT_ACTION_TYPE_ID}. */
export const NOTIFICATION_INTENT_VIEW_ACTION_ID = "view";

/** Current notification permission status, cached after first resolution. */
type PermissionState = "granted" | "denied" | "prompt" | "unsupported";

let cachedPermission: PermissionState | null = null;
let pendingPermissionRequest: Promise<PermissionState> | null = null;
let tapListenersRegistered = false;
let conversationActionTypeRegistered = false;
let conversationActionTypePromise: Promise<void> | null = null;
const recentNativeDeliveryIds = new Set<string>();
const nativeDeliveryPromises = new Map<string, Promise<void>>();
const MAX_RECENT_DELIVERY_IDS = 128;
const NOTIFICATION_DELIVERY_KEY_MAX_CHARACTERS = 512;
const focusedNotificationDeliveryKeys = new Set<string>();
const MAX_FOCUSED_NOTIFICATION_DELIVERY_KEYS = 128;
const INVALID_NOTIFICATION_IDENTITY_SENTINEL = Object.freeze({});

type NotificationIdentifier =
  | { status: "absent" }
  | { status: "invalid"; value: string }
  | { status: "valid"; value: string };

function notificationIdentifier(value: string | undefined): NotificationIdentifier {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { status: "absent" };
  }
  return trimmed.length <= NOTIFICATION_DELIVERY_KEY_MAX_CHARACTERS
    ? { status: "valid", value: trimmed }
    : { status: "invalid", value: trimmed };
}

function notificationDeliveryKey(
  correlationId: string | undefined,
  deliveryId: string | undefined,
  requestKey?: string,
): NotificationIdentifier {
  for (const candidate of [correlationId, deliveryId, requestKey]) {
    const identifier = notificationIdentifier(candidate);
    if (identifier.status !== "absent") {
      return identifier;
    }
  }
  return { status: "absent" };
}

function retainFocusedNotificationDeliveryKey(key: string): void {
  focusedNotificationDeliveryKeys.delete(key);
  focusedNotificationDeliveryKeys.add(key);
  if (
    focusedNotificationDeliveryKeys.size >
    MAX_FOCUSED_NOTIFICATION_DELIVERY_KEYS
  ) {
    const oldest = focusedNotificationDeliveryKeys.values().next().value;
    if (oldest) {
      focusedNotificationDeliveryKeys.delete(oldest);
    }
  }
}

/** Share focused-chat suppression across the foreground FCM and SSE routes. */
export function shouldSuppressFocusedNotificationDelivery(
  correlationId: string | undefined,
  deliveryId: string | undefined,
  focused: boolean,
): boolean {
  const key = notificationDeliveryKey(correlationId, deliveryId);
  if (key.status !== "valid") {
    return focused;
  }
  if (focusedNotificationDeliveryKeys.has(key.value)) {
    retainFocusedNotificationDeliveryKey(key.value);
    return true;
  }
  if (!focused) {
    return false;
  }
  retainFocusedNotificationDeliveryKey(key.value);
  return true;
}

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

/**
 * Register the conversation action category with the OS. Capacitor's
 * `registerActionTypes` replaces the process-wide category set, so this
 * must include every action type we rely on. The iOS shell also registers
 * the same identifier at launch so remote pushes can show the action
 * before JS loads.
 */
async function ensureConversationActionType(): Promise<void> {
  if (conversationActionTypeRegistered) {
    return;
  }
  if (conversationActionTypePromise) {
    await conversationActionTypePromise;
    return;
  }
  conversationActionTypePromise = (async () => {
    try {
      await LocalNotifications.registerActionTypes({
        types: [
          {
            id: NOTIFICATION_INTENT_ACTION_TYPE_ID,
            actions: [
              {
                id: NOTIFICATION_INTENT_VIEW_ACTION_ID,
                title: t("localNotification.goToConversation"),
                foreground: true,
              },
            ],
          },
        ],
      });
      conversationActionTypeRegistered = true;
    } catch {
      // Best-effort: banners still fire without the action button.
    } finally {
      conversationActionTypePromise = null;
    }
  })();
  await conversationActionTypePromise;
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
    try {
      await window.vellum.notifications.onAction((event) => {
        dispatchNotificationTap({
          conversationId: event.conversationId,
          sourceEventName: `electron:${event.category}:${event.kind}`,
          deliveryId: event.deliveryId,
          identity: event.identity,
        });
      });
    } catch {
      tapListenersRegistered = false;
    }
    return;
  }

  if (!isNativePlatform()) {
    return;
  }
  try {
    await ensureConversationActionType();
    await LocalNotifications.addListener(
      "localNotificationActionPerformed",
      (action) => {
        const extra = action.notification.extra as
          | NotificationTapPayload
          | undefined;
        if (extra) {
          dispatchNotificationTap(extra);
        }
      },
    );
  } catch {
    // Listener registration is best-effort — a failure here means taps
    // won't deep-link, but banners will still fire.
    tapListenersRegistered = false;
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
  handler: NotificationTapHandler,
): void {
  registerNotificationTapHandler(handler);
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

async function scheduleLegacyNativeNotification(
  correlationId: string | undefined,
  notification: LocalNotificationSchema,
): Promise<void> {
  if (correlationId && isNativeAndroid()) {
    await scheduleNativeDelivery(correlationId, notification);
    return;
  }
  await ensureAndroidAlertsChannel();
  await LocalNotifications.schedule({ notifications: [notification] });
}

function nativeDeliveryFailure(
  result: Exclude<
    NotificationDeliveryResult,
    { status: "posted" } | { status: "duplicate" }
  >,
): string {
  if (result.status === "blocked" || result.status === "unavailable") {
    return result.reason ?? `Native notification ${result.status}`;
  }
  return result.errorMessage ?? `Native notification ${result.status}`;
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

export function isFocusedNotificationConversation(
  conversationId: string,
  pathname: string,
): boolean {
  return (
    conversationId === useConversationStore.getState().activeConversationId &&
    isConversationChatPath(pathname) &&
    isVisibleToUser()
  );
}

export interface PostLocalNotificationArgs {
  title: string;
  body: string;
  sourceEventName: string;
  /** Verified assistant name carried by this notification event. */
  assistantName?: string;
  deliveryId?: string;
  correlationId?: string;
  deepLinkMetadata?: Record<string, unknown>;
  /** Routing identity captured by the event subscriber before any await. */
  identity?: NotificationIdentity;
  /** Identity-store name captured for the same scoped routing identity. */
  identityStoreName?: OwnedNotificationName | null;
  /** Preserve a present untrusted push identity so tap routing fails closed. */
  requiresScopedIdentity?: boolean;
  rawIdentity?: unknown;
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

export type NotificationSoundDisposition =
  | "web-sound"
  | "native-owned"
  | "silent";

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

type SenderPayload = Pick<
  ShowNotificationPayload,
  | "presentation"
  | "identity"
  | "nameProvenance"
  | "suppressGroupTitle"
  | "sender"
>;

function resolveSenderAtIntent(
  args: PostLocalNotificationArgs,
  electronHost: boolean,
): NotificationSenderResolution | null {
  if (
    !args.identity ||
    (args.assistantId !== undefined &&
      args.identity.assistantId !== args.assistantId)
  ) {
    return null;
  }
  const flags = useClientFeatureFlagStore.getState();
  const presentationEnabled = electronHost
    ? flags.pushAvatarSender
    : flags.localNotificationAvatar;
  return resolveNotificationSender({
    presentation: presentationEnabled ? "assistant" : "app",
    identity: args.identity,
    assistantName: args.assistantName,
    identityStoreName: args.identityStoreName,
    verifiedSnapshot: getNotificationIdentitySnapshot(args.identity),
    title: args.title,
  });
}

function senderPayload(
  resolution: NotificationSenderResolution | null,
): SenderPayload {
  if (!resolution) {
    return {};
  }
  if (resolution.presentation === "app") {
    return {
      presentation: "app",
      identity: resolution.identity,
    };
  }
  return {
    presentation: "assistant",
    identity: resolution.identity,
    nameProvenance: resolution.nameProvenance,
    ...(resolution.suppressGroupTitle
      ? { suppressGroupTitle: resolution.suppressGroupTitle }
      : {}),
    ...(resolution.sender ? { sender: resolution.sender } : {}),
  };
}

function browserNotificationIcon(
  resolution: NotificationSenderResolution | null,
): string | undefined {
  return resolution?.presentation === "assistant" && resolution.sender
    ? `data:image/png;base64,${resolution.sender.avatarBase64}`
    : undefined;
}

/**
 * Display a native notification. On Capacitor iOS this schedules via
 * `UNUserNotificationCenter`; on desktop browsers it calls the Web
 * Notification API. No-ops silently when notifications are unsupported or
 * permission has been denied — callers should not need to branch.
 */
export async function postLocalNotification(
  args: PostLocalNotificationArgs,
): Promise<NotificationSoundDisposition> {
  const electronHost = isElectron();
  const senderResolution = resolveSenderAtIntent(args, electronHost);
  const presentationPayload = senderPayload(senderResolution);
  const { sender: _sender, ...tapPresentationPayload } = presentationPayload;

  if (!isNotificationsSupported()) {
    if (args.assistantId && args.deliveryId) {
      await sendNotificationIntentAck(
        args.assistantId,
        args.deliveryId,
        false,
        "Notifications not supported on this client",
      );
    }
    return "web-sound";
  }

  // Electron path: route through the main-process bridge which uses
  // `electron.Notification` (supports macOS action buttons). Permission
  // is handled by the main process — we skip the renderer permission
  // dance entirely.
  if (electronHost && window.vellum?.notifications) {
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
        ...presentationPayload,
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
    return "web-sound";
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
    return "web-sound";
  }

  const conversationId = extractConversationId(args.deepLinkMetadata);
  const tapPayload = {
    conversationId,
    sourceEventName: args.sourceEventName,
    deliveryId: args.deliveryId,
    ...tapPresentationPayload,
    ...(args.requiresScopedIdentity
      ? { identity: args.rawIdentity as NotificationIdentity }
      : {}),
  } satisfies NotificationTapPayload;

  let success = true;
  let errorMessage: string | undefined;
  let nativeSoundOwned = false;

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
      return isNativeAndroid() ? "native-owned" : "web-sound";
    }

    const fallbackRequestKey = `${args.sourceEventName}:${args.title}:${args.body}`;
    const key = notificationDeliveryKey(
      args.correlationId,
      args.deliveryId,
      fallbackRequestKey,
    );
    if (key.status !== "valid") {
      if (args.assistantId && args.deliveryId) {
        await sendNotificationIntentAck(
          args.assistantId,
          args.deliveryId,
          false,
          "Invalid notification delivery key",
        );
      }
      return "silent";
    }
    const correlation = notificationIdentifier(args.correlationId);
    const delivery = notificationIdentifier(args.deliveryId);
    const correlationId =
      correlation.status === "valid" ? correlation.value : undefined;
    const normalizedDeliveryId =
      delivery.status === "valid" ? delivery.value : undefined;
    const seed = key.value;
    const requestKey = key.value;
    const notification: LocalNotificationSchema = {
      id: toNotificationId(seed),
      title: args.title,
      body: args.body,
      extra: tapPayload,
      ...(conversationId
        ? { actionTypeId: NOTIFICATION_INTENT_ACTION_TYPE_ID }
        : {}),
      ...(isNativeAndroid() ? { channelId: ANDROID_ALERTS_CHANNEL_ID } : {}),
    };
    try {
      const legacyCorrelationId = correlationId ?? normalizedDeliveryId;
      const useIOSNativeOwner =
        isNativeIOS() &&
        useClientFeatureFlagStore.getState().localNotificationAvatar;
      if (isNativeAndroid()) {
        const nativeResult = await postAndroidSenderNotification({
          correlationId,
          deliveryId: normalizedDeliveryId,
          requestKey,
          id: notification.id,
          title: notification.title,
          body: notification.body,
          extra: tapPayload,
          ...(notification.actionTypeId
            ? { actionTypeId: notification.actionTypeId }
            : {}),
          channelId: notification.channelId,
          ...(notification.actionTypeId
            ? { category: notification.actionTypeId }
            : {}),
          conversationId,
          deepLinkMetadata: args.deepLinkMetadata,
          presentation: senderResolution?.presentation ?? "app",
          ...(senderResolution ? { identity: senderResolution.identity } : {}),
          ...(senderResolution?.presentation === "assistant"
            ? {
                name: senderResolution.name,
                nameProvenance: senderResolution.nameProvenance,
                ...(senderResolution.suppressGroupTitle
                  ? { suppressGroupTitle: true }
                  : {}),
                ...(senderResolution.sender
                  ? { sender: senderResolution.sender }
                  : {}),
              }
            : {}),
        });
        if (allowsLegacyAndroidNotificationFallback(nativeResult)) {
          await ensureConversationActionType();
          await scheduleLegacyNativeNotification(
            legacyCorrelationId,
            notification,
          );
          nativeSoundOwned = true;
        } else {
          if (
            nativeResult.status !== "posted" &&
            nativeResult.status !== "duplicate"
          ) {
            success = false;
            errorMessage = nativeDeliveryFailure(nativeResult);
          }
          if (args.assistantId && args.deliveryId) {
            await sendNotificationIntentAck(
              args.assistantId,
              args.deliveryId,
              success,
              errorMessage,
            );
          }
          return "native-owned";
        }
      } else {
        await ensureConversationActionType();
      }
      if (useIOSNativeOwner) {
        const nativeResult = await postSenderNotification({
          correlationId,
          deliveryId: normalizedDeliveryId,
          requestKey,
          id: notification.id,
          title: notification.title,
          body: notification.body,
          extra: tapPayload,
          ...(notification.actionTypeId
            ? { actionTypeId: notification.actionTypeId }
            : {}),
          presentation: senderResolution?.presentation ?? "app",
          ...(senderResolution ? { identity: senderResolution.identity } : {}),
          ...(senderResolution?.presentation === "assistant"
            ? {
                name: senderResolution.name,
                nameProvenance: senderResolution.nameProvenance,
                ...(senderResolution.suppressGroupTitle
                  ? { suppressGroupTitle: true }
                  : {}),
                ...(senderResolution.sender
                  ? { sender: senderResolution.sender }
                  : {}),
              }
            : {}),
        });
        if (allowsLegacyNotificationFallback(nativeResult)) {
          await scheduleLegacyNativeNotification(
            legacyCorrelationId,
            notification,
          );
        } else if (
          nativeResult.status !== "posted" &&
          nativeResult.status !== "duplicate"
        ) {
          success = false;
          errorMessage = nativeDeliveryFailure(nativeResult);
        }
      } else if (!isNativeAndroid()) {
        await scheduleLegacyNativeNotification(
          legacyCorrelationId,
          notification,
        );
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
    const options: NotificationOptions = {
      body: args.body,
      tag,
      data: tapPayload,
    };
    const icon = browserNotificationIcon(senderResolution);
    try {
      let n: Notification;
      if (icon) {
        try {
          n = new Notification(args.title, { ...options, icon });
        } catch {
          n = new Notification(args.title, options);
        }
      } else {
        n = new Notification(args.title, options);
      }
      n.onclick = () => {
        window.focus();
        dispatchNotificationTap(tapPayload);
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
  return nativeSoundOwned ? "native-owned" : "web-sound";
}

export interface ForegroundRemotePushContext {
  shouldSuppressConversation?: (conversationId: string) => boolean;
}

export function postForegroundRemotePush(
  notification: PushNotificationSchema,
  context: ForegroundRemotePushContext = {},
): void {
  if (!isNativeAndroid()) {
    return;
  }
  const data =
    typeof notification.data === "object" && notification.data !== null
      ? (notification.data as Record<string, unknown>)
      : {};
  // Trimmed, and blank read as absent, because the Android shell trims every
  // field it hashes into a notification id (PushDataMessage.trimmed): padded
  // copy that seeded two different ids would show the same delivery twice.
  const text = (value: unknown): string | undefined => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed === "" ? undefined : trimmed;
  };
  const dataDeliveryId =
    typeof data.delivery_id === "string" ? data.delivery_id : undefined;
  const dataDeliveryIdentifier = notificationIdentifier(dataDeliveryId);
  const messageIdentifier = notificationIdentifier(
    typeof notification.id === "string" ? notification.id : undefined,
  );
  const messageDeliveryKey =
    messageIdentifier.status === "absent"
      ? undefined
      : `fcm-message:${messageIdentifier.value}`;
  const deliveryId =
    dataDeliveryIdentifier.status === "absent"
      ? messageDeliveryKey
      : dataDeliveryIdentifier.value;
  const sourceEventName = text(data.source_event_name) ?? "remote_push";
  const conversationId = extractPushConversationId(data);
  if (
    shouldSuppressFocusedNotificationDelivery(
      deliveryId,
      undefined,
      conversationId !== undefined &&
        context.shouldSuppressConversation?.(conversationId) === true,
    )
  ) {
    return;
  }
  const scopedTap = extractScopedPushTapPayload(data);
  const requiresScopedIdentity = Object.prototype.hasOwnProperty.call(
    data,
    "identity",
  ) && scopedTap === null;
  const deepLinkValue = data.deep_link;
  let deepLinkMetadata: Record<string, unknown> | undefined;
  if (typeof deepLinkValue === "object" && deepLinkValue !== null) {
    deepLinkMetadata = deepLinkValue as Record<string, unknown>;
  } else if (typeof deepLinkValue === "string") {
    try {
      const parsed = JSON.parse(deepLinkValue) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        deepLinkMetadata = parsed as Record<string, unknown>;
      }
    } catch {
      deepLinkMetadata = undefined;
    }
  }

  const resolvedDeepLinkMetadata = deepLinkMetadata
    ? conversationId &&
      extractConversationId(deepLinkMetadata) !== conversationId
      ? { ...deepLinkMetadata, conversationId }
      : deepLinkMetadata
    : conversationId
      ? { conversationId }
      : undefined;

  void postLocalNotification({
    // A data-only push carries no notification block, so the copy the OS
    // would have rendered lives in `data`.
    title: text(notification.title) ?? text(data.title) ?? "Vellum",
    body: text(notification.body) ?? text(data.body) ?? "",
    sourceEventName,
    assistantName: text(data.sender_name),
    deliveryId,
    correlationId: deliveryId,
    deepLinkMetadata: resolvedDeepLinkMetadata,
    identity: scopedTap?.identity,
    requiresScopedIdentity,
    rawIdentity: requiresScopedIdentity
      ? INVALID_NOTIFICATION_IDENTITY_SENTINEL
      : undefined,
  });
}

export function __resetNotificationsStateForTests(): void {
  cachedPermission = null;
  pendingPermissionRequest = null;
  tapListenersRegistered = false;
  conversationActionTypeRegistered = false;
  conversationActionTypePromise = null;
  __resetNotificationTapsForTests();
  recentNativeDeliveryIds.clear();
  nativeDeliveryPromises.clear();
  focusedNotificationDeliveryKeys.clear();
}
