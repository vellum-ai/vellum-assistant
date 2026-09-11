/**
 * `postLocalNotification` native-branch behavior, focused on the
 * remote-push dedup skip: the local banner is scheduled whenever
 * `remotePushDispatched` is absent or false; it is skipped only when the
 * daemon confirmed an accepted remote push, this device holds a
 * session-confirmed APNs registration, and the app was hidden when the
 * intent arrived (the APNs banner covers that case).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  NotificationActionEvent,
  NotificationIdentity,
  ShowNotificationPayload,
} from "@vellumai/ipc-contract";

import * as daemonSdk from "@/generated/daemon/sdk.gen";
import * as i18nRuntime from "@/i18n";
import * as androidNotificationChannels from "@/runtime/android-notification-channels";
import * as nativeAuthRuntime from "@/runtime/native-auth";
import * as platformDetection from "@/runtime/platform-detection";
import * as pushRegistration from "@/runtime/push-registration";
import type { NotificationTapPayload } from "@/runtime/notification-taps";

// ── host platform guards ─────────────────────────────────────────────────────
//
// Force the native (Capacitor) branch: `isNativePlatform` reports false
// under happy-dom, and the Electron branch would return before reaching
// the code under test.

let nativePlatform = true;
mock.module("@/runtime/native-auth", () => ({
  ...nativeAuthRuntime,
  isNativePlatform: () => nativePlatform,
}));
let nativeAndroid = false;
mock.module("@/runtime/platform-detection", () => ({
  ...platformDetection,
  isNativeAndroid: () => nativeAndroid,
}));

// ── push-registration read-only helpers ──────────────────────────────────────
//
// Mocked as pure flags; the helpers' own behavior is covered by
// push-registration.test.ts.

let sessionConfirmedAssistantId: string | null = null;
mock.module("@/runtime/push-registration", () => ({
  ...pushRegistration,
  hasSessionConfirmedRemotePushRegistration: (assistantId: string) =>
    sessionConfirmedAssistantId === assistantId,
  extractPushConversationId: (data: Record<string, unknown>) =>
    typeof data.conversationId === "string" ? data.conversationId : undefined,
}));

const ensureAndroidAlertsChannelMock = mock(async () => {});
mock.module("@/runtime/android-notification-channels", () => ({
  ...androidNotificationChannels,
  ANDROID_ALERTS_CHANNEL_ID: "vellum-alerts",
  ensureAndroidAlertsChannel: ensureAndroidAlertsChannelMock,
}));
mock.module("@/i18n", () => ({
  ...i18nRuntime,
  t: (key: string) =>
    key === "localNotification.goToConversation" ? "Go to Conversation" : key,
}));

// ── @capacitor/local-notifications ───────────────────────────────────────────

interface ScheduleArg {
  notifications: Array<{
    id: number;
    title: string;
    body: string;
    channelId?: string;
    actionTypeId?: string;
    extra?: Record<string, unknown>;
  }>;
}
interface RegisterActionTypesArg {
  types: Array<{
    id: string;
    actions: Array<{ id: string; title: string; foreground?: boolean }>;
  }>;
}
const scheduleMock = mock(async (_arg: ScheduleArg) => {});
const registerActionTypesMock = mock(
  async (_arg: RegisterActionTypesArg) => {},
);
type LocalActionListener = (action: {
  notification: { extra?: unknown };
}) => void;
let localActionListener: LocalActionListener | null = null;
const addLocalListenerMock = mock(
  async (_eventName: string, listener: LocalActionListener) => {
    localActionListener = listener;
    return { remove: async () => {} };
  },
);
mock.module("@capacitor/local-notifications", () => ({
  LocalNotifications: {
    checkPermissions: async () => ({ display: "granted" }),
    requestPermissions: async () => ({ display: "granted" }),
    schedule: scheduleMock,
    registerActionTypes: registerActionTypesMock,
    addListener: addLocalListenerMock,
  },
}));

// ── daemon ack SDK ───────────────────────────────────────────────────────────

interface AckArg {
  path: { assistant_id: string };
  body: { deliveryId: string; success: boolean; errorMessage?: string };
  throwOnError: boolean;
}
const ackArgs: AckArg[] = [];
const ackMock = mock(async (arg: AckArg) => {
  ackArgs.push(arg);
  return { data: undefined, error: undefined };
});
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  notificationintentresultPost: ackMock,
}));

const {
  NOTIFICATION_INTENT_ACTION_TYPE_ID,
  NOTIFICATION_INTENT_VIEW_ACTION_ID,
  postForegroundRemotePush,
  postLocalNotification,
  setNotificationTapHandler,
  __resetNotificationsStateForTests,
} = await import("@/runtime/notifications");
const {
  __clearNotificationIdentitySnapshotsForTests,
  beginNotificationIdentityPublication,
  createNotificationIdentity,
  getNotificationIdentitySnapshot,
  publishPreparedNotificationIdentity,
} = await import("@/runtime/notification-avatar");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");

const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
};

const baseArgs = {
  title: "Reminder",
  body: "Stand up",
  sourceEventName: "reminder.fired",
  deliveryId: "delivery-1",
  assistantId: "assistant-1",
};

function testIdentity(
  scopeId = "notification:scope:test",
  assistantId = "assistant-1",
  nativeSenderId = "123e4567-e89b-12d3-a456-426614174000",
): NotificationIdentity {
  const identity = createNotificationIdentity(
    scopeId,
    assistantId,
    nativeSenderId,
  );
  if (!identity) {
    throw new Error("Expected a notification identity");
  }
  return identity;
}

interface BrowserNotificationCall {
  title: string;
  options?: NotificationOptions;
}

interface BrowserNotificationInstance {
  onclick: (() => void) | null;
  close: () => void;
}

async function withBrowserNotificationMock(
  run: (
    calls: BrowserNotificationCall[],
    instances: BrowserNotificationInstance[],
  ) => Promise<void>,
  onConstruct?: (
    title: string,
    options: NotificationOptions | undefined,
    attempt: number,
  ) => void,
): Promise<void> {
  const originalNotification = globalThis.Notification;
  const calls: BrowserNotificationCall[] = [];
  const instances: BrowserNotificationInstance[] = [];
  class TestNotification {
    static permission: NotificationPermission = "granted";
    static requestPermission = async (): Promise<NotificationPermission> =>
      "granted";
    onclick: (() => void) | null = null;
    close = mock(() => {});

    constructor(title: string, options?: NotificationOptions) {
      calls.push({ title, options });
      onConstruct?.(title, options, calls.length);
      instances.push(this);
    }
  }
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: TestNotification,
  });
  try {
    await run(calls, instances);
  } finally {
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: originalNotification,
    });
  }
}

beforeEach(() => {
  nativePlatform = true;
  nativeAndroid = false;
  sessionConfirmedAssistantId = null;
  scheduleMock.mockClear();
  registerActionTypesMock.mockClear();
  ackMock.mockClear();
  ackArgs.length = 0;
  ensureAndroidAlertsChannelMock.mockClear();
  localActionListener = null;
  addLocalListenerMock.mockReset();
  addLocalListenerMock.mockImplementation(
    async (_eventName: string, listener: LocalActionListener) => {
      localActionListener = listener;
      return { remove: async () => {} };
    },
  );
  __clearNotificationIdentitySnapshotsForTests();
  useClientFeatureFlagStore.setState({
    pushAvatarSender: false,
    localNotificationAvatar: false,
  });
  __resetNotificationsStateForTests();
  delete (window as unknown as { vellum?: unknown }).vellum;
  setVisibility("visible");
});

describe("postLocalNotification remote-push dedup (native branch)", () => {
  test("hidden + dispatched + registered: skips the local banner and acks success", async () => {
    sessionConfirmedAssistantId = "assistant-1";
    setVisibility("hidden");

    await postLocalNotification({ ...baseArgs, remotePushDispatched: true });

    expect(scheduleMock).not.toHaveBeenCalled();
    expect(ackArgs).toEqual([
      {
        path: { assistant_id: "assistant-1" },
        body: { deliveryId: "delivery-1", success: true },
        throwOnError: false,
      },
    ]);
  });

  test("visible app schedules the local banner (the only foreground surface)", async () => {
    sessionConfirmedAssistantId = "assistant-1";
    setVisibility("visible");

    await postLocalNotification({ ...baseArgs, remotePushDispatched: true });

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]?.[0].notifications[0]?.channelId).toBe(
      undefined,
    );
    expect(ackArgs).toEqual([
      {
        path: { assistant_id: "assistant-1" },
        body: { deliveryId: "delivery-1", success: true },
        throwOnError: false,
      },
    ]);
  });

  test("visible at intent arrival, hidden after the permission await: schedules", async () => {
    sessionConfirmedAssistantId = "assistant-1";
    setVisibility("visible");

    // The call's synchronous prefix snapshots visibility, then suspends on
    // the permission await; flipping to hidden while it is pending mimics
    // the user backgrounding the app mid-await. The entry-time snapshot
    // must win, so the local banner is still scheduled.
    const pending = postLocalNotification({
      ...baseArgs,
      remotePushDispatched: true,
    });
    setVisibility("hidden");
    await pending;

    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  test("explicit empty platforms override legacy APNs acceptance", async () => {
    sessionConfirmedAssistantId = "assistant-1";
    setVisibility("hidden");

    await postLocalNotification({
      ...baseArgs,
      remotePushDispatched: true,
      remotePushPlatforms: [],
    });

    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  test("dispatched but no active registration (e.g. permission denied): schedules", async () => {
    setVisibility("hidden");

    await postLocalNotification({ ...baseArgs, remotePushDispatched: true });

    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  test("dispatched but registration belongs to a different assistant: schedules", async () => {
    sessionConfirmedAssistantId = "assistant-2";
    setVisibility("hidden");

    await postLocalNotification({ ...baseArgs, remotePushDispatched: true });

    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  test("no assistantId: schedules even when hidden and dispatched, no ack", async () => {
    sessionConfirmedAssistantId = "assistant-1";
    setVisibility("hidden");

    await postLocalNotification({
      ...baseArgs,
      assistantId: undefined,
      remotePushDispatched: true,
    });

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(ackMock).not.toHaveBeenCalled();
  });

  test("skip without a deliveryId still skips but sends no ack", async () => {
    sessionConfirmedAssistantId = "assistant-1";
    setVisibility("hidden");

    await postLocalNotification({
      ...baseArgs,
      deliveryId: undefined,
      remotePushDispatched: true,
    });

    expect(scheduleMock).not.toHaveBeenCalled();
    expect(ackMock).not.toHaveBeenCalled();
  });

  test("hidden Android trusts only explicit FCM acceptance", async () => {
    nativeAndroid = true;
    sessionConfirmedAssistantId = "assistant-1";
    setVisibility("hidden");

    await postLocalNotification({
      ...baseArgs,
      remotePushDispatched: false,
      remotePushPlatforms: ["android"],
    });

    expect(scheduleMock).not.toHaveBeenCalled();
  });

  test("hidden iOS trusts APNs acceptance from a partial platform failure", async () => {
    sessionConfirmedAssistantId = "assistant-1";
    setVisibility("hidden");

    await postLocalNotification({
      ...baseArgs,
      remotePushDispatched: false,
      remotePushPlatforms: ["ios"],
    });

    expect(scheduleMock).not.toHaveBeenCalled();
  });

  test("foreground Android push and SSE schedule once by correlation ID", async () => {
    nativeAndroid = true;
    const push = {
      id: "message-1",
      title: "Reminder",
      body: "Stand up",
      data: {
        delivery_id: "delivery-fcm",
        source_event_name: "reminder.fired",
        conversationId: "conv-1",
      },
    };
    postForegroundRemotePush(push);
    await postLocalNotification({
      ...baseArgs,
      deliveryId: "delivery-sse",
      correlationId: "delivery-fcm",
    });
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]?.[0].notifications[0]?.channelId).toBe(
      "vellum-alerts",
    );
  });

  test("a foreground data-only push reads its title and body from data", async () => {
    nativeAndroid = true;
    postForegroundRemotePush({
      id: "message-2",
      data: {
        title: "Ada",
        body: "Standup notes are up",
        delivery_id: "delivery-data-only",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    const scheduled = scheduleMock.mock.calls[0]?.[0].notifications[0];
    expect(scheduled?.title).toBe("Ada");
    expect(scheduled?.body).toBe("Standup notes are up");
  });

  /**
   * The Android shell trims every field it hashes into a notification id, so
   * padded copy must not seed a second id and show the delivery twice. The
   * expected id is the one PushDataMessageTest pins for the same push.
   */
  test("a padded data-only push hashes to the id the Android shell derives", async () => {
    nativeAndroid = true;
    postForegroundRemotePush({
      id: "   ",
      data: {
        title: "  Weekly review  ",
        body: "\tReady when you are.\n",
        source_event_name: " remote_push ",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const scheduled = scheduleMock.mock.calls[0]?.[0].notifications[0];
    expect(scheduled?.title).toBe("Weekly review");
    expect(scheduled?.body).toBe("Ready when you are.");
    expect(scheduled?.id).toBe(126856326);
  });

  test("a concurrent waiter retries after scheduling fails", async () => {
    nativeAndroid = true;
    let rejectFirst!: (error: Error) => void;
    scheduleMock.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const first = postLocalNotification(baseArgs);
    const waiter = postLocalNotification(baseArgs);
    await new Promise((resolve) => setTimeout(resolve, 0));
    rejectFirst(new Error("native bridge failed"));
    await Promise.all([first, waiter]);
    expect(scheduleMock).toHaveBeenCalledTimes(2);
    expect(ackArgs.map(({ body }) => body.success)).toEqual([true, true]);
  });

  test("registers a go-to-conversation action and attaches it when a conversation is present", async () => {
    await postLocalNotification({
      ...baseArgs,
      deepLinkMetadata: { conversationId: "conv-xyz" },
    });

    expect(registerActionTypesMock).toHaveBeenCalledTimes(1);
    expect(registerActionTypesMock.mock.calls[0]?.[0]).toEqual({
      types: [
        {
          id: NOTIFICATION_INTENT_ACTION_TYPE_ID,
          actions: [
            {
              id: NOTIFICATION_INTENT_VIEW_ACTION_ID,
              title: "Go to Conversation",
              foreground: true,
            },
          ],
        },
      ],
    });
    expect(scheduleMock.mock.calls[0]?.[0].notifications[0]?.actionTypeId).toBe(
      NOTIFICATION_INTENT_ACTION_TYPE_ID,
    );
  });

  test("registers the action type even when the banner has no conversation", async () => {
    await postLocalNotification(baseArgs);

    expect(registerActionTypesMock).toHaveBeenCalledTimes(1);
    expect(
      scheduleMock.mock.calls[0]?.[0].notifications[0]?.actionTypeId,
    ).toBeUndefined();
  });
});

// ── Scoped presentation policy ──────────────────────────────────────────────

describe("postLocalNotification scoped presentation policy", () => {
  const AVATAR_HASH = "b".repeat(64);
  const AVATAR = {
    avatarBase64: "iVBORw==",
    avatarHash: AVATAR_HASH,
  };
  const showMock = mock(async (_payload: ShowNotificationPayload) => ({
    success: true,
  }));

  function prepareIdentity(
    identity: NotificationIdentity,
    name?: string,
    withAvatar = true,
  ): void {
    const publication = beginNotificationIdentityPublication(identity);
    publishPreparedNotificationIdentity(publication, {
      ...(name ? { name, nameProvenance: "identity-store" } : {}),
      ...(withAvatar ? { avatar: AVATAR } : {}),
    });
  }

  function electronArgs(identity = testIdentity()) {
    return {
      ...baseArgs,
      identity,
      identityStoreName: { identity, name: "Identity Store Name" },
    };
  }

  beforeEach(() => {
    showMock.mockClear();
    useClientFeatureFlagStore.setState({ pushAvatarSender: true });
    (window as unknown as { vellum?: unknown }).vellum = {
      platform: "electron",
      notifications: { show: showMock },
    };
  });

  afterEach(() => {
    delete (window as unknown as { vellum?: unknown }).vellum;
  });

  test("uses the event name before exact identity store and verified RAM", async () => {
    const identity = testIdentity();
    prepareIdentity(identity, "Verified RAM Name");

    await postLocalNotification({
      ...electronArgs(identity),
      assistantName: "  Event Name  ",
      sourceEventName: "activity.failed",
    });

    expect(showMock.mock.calls[0]?.[0]).toMatchObject({
      presentation: "assistant",
      identity,
      nameProvenance: "event",
      sender: {
        id: identity.nativeSenderId,
        name: "Event Name",
        ...AVATAR,
      },
    });
  });

  test("uses the exact scoped identity-store name when the optional event name is absent", async () => {
    const identity = testIdentity();
    prepareIdentity(identity, "Verified RAM Name");

    await postLocalNotification(electronArgs(identity));

    expect(showMock.mock.calls[0]?.[0]).toMatchObject({
      presentation: "assistant",
      identity,
      nameProvenance: "identity-store",
      sender: {
        id: identity.nativeSenderId,
        name: "Identity Store Name",
        ...AVATAR,
      },
    });
  });

  test("falls back to verified same-key RAM", async () => {
    const identity = testIdentity();
    prepareIdentity(identity, "Verified RAM Name");

    await postLocalNotification({
      ...baseArgs,
      identity,
      assistantName: " ",
    });

    expect(showMock.mock.calls[0]?.[0]).toMatchObject({
      presentation: "assistant",
      identity,
      nameProvenance: "verified-memory",
      sender: {
        id: identity.nativeSenderId,
        name: "Verified RAM Name",
        ...AVATAR,
      },
    });
  });

  test("uses title only for this display and suppresses duplicate group text", async () => {
    const identity = testIdentity();
    prepareIdentity(identity, undefined);

    await postLocalNotification({ ...baseArgs, identity });

    expect(showMock.mock.calls[0]?.[0]).toMatchObject({
      presentation: "assistant",
      identity,
      nameProvenance: "title",
      suppressGroupTitle: true,
      sender: {
        id: identity.nativeSenderId,
        name: "Reminder",
        ...AVATAR,
      },
    });
    expect(getNotificationIdentitySnapshot(identity)?.name).toBeUndefined();
  });

  test("blank names and title degrade to app presentation without classifying sourceEventName", async () => {
    const identity = testIdentity();
    prepareIdentity(identity, undefined);

    await postLocalNotification({
      ...baseArgs,
      identity,
      assistantName: " ",
      title: " ",
      sourceEventName: "assistant.named.event",
    });

    const payload = showMock.mock.calls[0]?.[0];
    expect(payload).toMatchObject({ presentation: "app", identity });
    expect(payload?.nameProvenance).toBeUndefined();
    expect(payload?.suppressGroupTitle).toBeUndefined();
    expect(payload?.sender).toBeUndefined();
  });

  test("sends explicit routing identity while avatar preparation is pending", async () => {
    const identity = testIdentity();

    await postLocalNotification({
      ...baseArgs,
      identity,
      assistantName: "Event Name",
    });

    const payload = showMock.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      presentation: "assistant",
      identity,
      nameProvenance: "event",
    });
    expect(payload?.sender).toBeUndefined();
  });

  test("rejects name and avatar data owned by another scoped identity", async () => {
    const identity = testIdentity();
    const otherIdentity = testIdentity("notification:scope:other");
    prepareIdentity(otherIdentity, "Other Name");

    await postLocalNotification({
      ...baseArgs,
      identity,
      identityStoreName: {
        identity: otherIdentity,
        name: "Other Store Name",
      },
      title: "Target Title",
    });

    const payload = showMock.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      presentation: "assistant",
      identity,
      nameProvenance: "title",
      suppressGroupTitle: true,
    });
    expect(payload?.sender).toBeUndefined();
  });

  test("rejects a routing identity for a different ack assistant", async () => {
    const identity = testIdentity(
      "notification:scope:other-assistant",
      "assistant-2",
    );
    prepareIdentity(identity, "Other Assistant");

    await postLocalNotification({
      ...baseArgs,
      identity,
      assistantName: "Other Assistant",
    });

    const payload = showMock.mock.calls[0]?.[0] ?? {};
    expect("identity" in payload).toBe(false);
    expect("presentation" in payload).toBe(false);
    expect("sender" in payload).toBe(false);
  });

  test("applies the same policy to health and failure pipeline events", async () => {
    const identity = testIdentity();
    prepareIdentity(identity, "Verified Name");

    for (const sourceEventName of [
      "credential.health_alert",
      "telegram.webhook_health_alert",
      "activity.failed",
    ]) {
      await postLocalNotification({
        ...baseArgs,
        deliveryId: `delivery-${sourceEventName}`,
        identity,
        assistantName: "Event Name",
        sourceEventName,
      });
    }

    expect(showMock).toHaveBeenCalledTimes(3);
    for (const [payload] of showMock.mock.calls) {
      expect(payload).toMatchObject({
        presentation: "assistant",
        identity,
        nameProvenance: "event",
      });
    }
  });

  test("uses push-avatar-sender only for Electron across all flag combinations", async () => {
    const identity = testIdentity();
    prepareIdentity(identity, "Verified Name");
    const combinations = [
      { pushAvatarSender: false, localNotificationAvatar: false },
      { pushAvatarSender: true, localNotificationAvatar: false },
      { pushAvatarSender: false, localNotificationAvatar: true },
      { pushAvatarSender: true, localNotificationAvatar: true },
    ];

    for (const combination of combinations) {
      useClientFeatureFlagStore.setState(combination);
      await postLocalNotification({
        ...baseArgs,
        deliveryId: `delivery-${combination.pushAvatarSender}-${combination.localNotificationAvatar}`,
        identity,
        assistantName: "Event Name",
      });
    }

    expect(
      showMock.mock.calls.map(([payload]) => payload.presentation),
    ).toEqual(["app", "assistant", "app", "assistant"]);
    expect(
      showMock.mock.calls.map(([payload]) => Boolean(payload.sender)),
    ).toEqual([false, true, false, true]);
  });

  test("keeps a legacy flag-off Electron call shape compatible", async () => {
    useClientFeatureFlagStore.setState({ pushAvatarSender: false });

    await postLocalNotification(baseArgs);

    const payload = showMock.mock.calls[0]?.[0] ?? {};
    expect("identity" in payload).toBe(false);
    expect("presentation" in payload).toBe(false);
    expect("sender" in payload).toBe(false);
  });
});

describe("postLocalNotification local-surface presentation flags", () => {
  test("uses local-notification-avatar only off Electron across all flag combinations", async () => {
    const identity = testIdentity();
    const combinations = [
      { pushAvatarSender: false, localNotificationAvatar: false },
      { pushAvatarSender: true, localNotificationAvatar: false },
      { pushAvatarSender: false, localNotificationAvatar: true },
      { pushAvatarSender: true, localNotificationAvatar: true },
    ];

    for (const combination of combinations) {
      useClientFeatureFlagStore.setState(combination);
      await postLocalNotification({
        ...baseArgs,
        deliveryId: `delivery-native-${combination.pushAvatarSender}-${combination.localNotificationAvatar}`,
        identity,
        assistantName: "Event Name",
      });
    }

    expect(
      scheduleMock.mock.calls.map(
        ([request]) => request.notifications[0]?.extra?.presentation,
      ),
    ).toEqual(["app", "app", "assistant", "assistant"]);
    for (const [request] of scheduleMock.mock.calls) {
      expect(request.notifications[0]?.extra?.identity).toEqual(identity);
    }
  });
});

describe("postLocalNotification browser avatar icons", () => {
  const avatar = {
    avatarBase64: "iVBORw==",
    avatarHash: "c".repeat(64),
  };
  const icon = `data:image/png;base64,${avatar.avatarBase64}`;

  function prepareIdentity(
    identity: NotificationIdentity,
    withAvatar = true,
  ): void {
    const publication = beginNotificationIdentityPublication(identity);
    publishPreparedNotificationIdentity(publication, {
      name: "Assistant",
      nameProvenance: "identity-store",
      ...(withAvatar ? { avatar } : {}),
    });
  }

  beforeEach(() => {
    nativePlatform = false;
  });

  test("uses only local-notification-avatar across all flag combinations", async () => {
    const identity = testIdentity();
    prepareIdentity(identity);
    const combinations = [
      { pushAvatarSender: false, localNotificationAvatar: false },
      { pushAvatarSender: true, localNotificationAvatar: false },
      { pushAvatarSender: false, localNotificationAvatar: true },
      { pushAvatarSender: true, localNotificationAvatar: true },
    ];

    await withBrowserNotificationMock(async (calls) => {
      for (const combination of combinations) {
        useClientFeatureFlagStore.setState(combination);
        await postLocalNotification({
          ...baseArgs,
          deliveryId: `delivery-browser-${combination.pushAvatarSender}-${combination.localNotificationAvatar}`,
          identity,
          assistantName: "Assistant",
        });
      }

      expect(calls.map(({ options }) => options?.icon)).toEqual([
        undefined,
        undefined,
        icon,
        icon,
      ]);
      expect(calls.map(({ title }) => title)).toEqual([
        "Reminder",
        "Reminder",
        "Reminder",
        "Reminder",
      ]);
    });
  });

  test("keeps prepared avatars isolated to their exact assistant identity", async () => {
    const first = testIdentity();
    const second = testIdentity(
      "notification:scope:test",
      "assistant-2",
      "123e4567-e89b-12d3-a456-426614174002",
    );
    prepareIdentity(second);
    useClientFeatureFlagStore.setState({ localNotificationAvatar: true });

    await withBrowserNotificationMock(async (calls) => {
      await postLocalNotification({
        ...baseArgs,
        deliveryId: "delivery-browser-first",
        identity: first,
        assistantName: "First Assistant",
      });
      await postLocalNotification({
        ...baseArgs,
        assistantId: "assistant-2",
        deliveryId: "delivery-browser-second",
        identity: second,
        assistantName: "Second Assistant",
      });

      expect(calls.map(({ options }) => options?.icon)).toEqual([
        undefined,
        icon,
      ]);
    });
  });

  test("preserves plain browser options when the exact identity has no avatar", async () => {
    const identity = testIdentity();
    prepareIdentity(identity, false);
    useClientFeatureFlagStore.setState({ localNotificationAvatar: true });

    await withBrowserNotificationMock(async (calls) => {
      await postLocalNotification({
        ...baseArgs,
        identity,
        assistantName: "Assistant",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.options).toMatchObject({
        body: "Stand up",
        tag: "delivery-1",
      });
      expect(calls[0]?.options?.icon).toBeUndefined();
      expect(calls[0]?.options).not.toHaveProperty("badge");
    });
  });

  test("retries once without the icon after synchronous constructor rejection", async () => {
    const identity = testIdentity();
    prepareIdentity(identity);
    useClientFeatureFlagStore.setState({ localNotificationAvatar: true });

    await withBrowserNotificationMock(
      async (calls, instances) => {
        await postLocalNotification({
          ...baseArgs,
          identity,
          assistantName: "Assistant",
        });

        expect(calls).toHaveLength(2);
        expect(calls[0]?.options?.icon).toBe(icon);
        expect(calls[1]?.options?.icon).toBeUndefined();
        expect(calls[1]?.options).toEqual({
          body: calls[0]?.options?.body,
          tag: calls[0]?.options?.tag,
          data: calls[0]?.options?.data,
        });
        expect(instances).toHaveLength(1);
        expect(ackArgs.at(-1)?.body.success).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(calls).toHaveLength(2);
      },
      (_title, options, attempt) => {
        if (attempt === 1 && options?.icon) {
          throw new TypeError("icon rejected");
        }
      },
    );
  });

  test("supplies the same verified icon across notification pipeline events", async () => {
    const identity = testIdentity();
    prepareIdentity(identity);
    useClientFeatureFlagStore.setState({ localNotificationAvatar: true });

    await withBrowserNotificationMock(async (calls) => {
      for (const sourceEventName of [
        "reminder.fired",
        "credential.health_alert",
        "telegram.webhook_health_alert",
        "activity.failed",
      ]) {
        await postLocalNotification({
          ...baseArgs,
          deliveryId: `delivery-browser-${sourceEventName}`,
          identity,
          assistantName: "Assistant",
          sourceEventName,
        });
      }

      expect(calls).toHaveLength(4);
      for (const call of calls) {
        expect(call.options?.icon).toBe(icon);
      }
    });
  });
});

describe("notification tap listener adapters", () => {
  async function flushTapQueue(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  test("forwards Electron action identity and conversation metadata", async () => {
    const identity = testIdentity();
    let actionListener: ((event: NotificationActionEvent) => void) | null =
      null;
    const show = mock(async (_payload: ShowNotificationPayload) => ({
      success: true,
    }));
    (window as unknown as { vellum?: unknown }).vellum = {
      platform: "electron",
      notifications: {
        show,
        onAction: (listener: (event: NotificationActionEvent) => void) => {
          actionListener = listener;
          return () => {};
        },
      },
    };
    const received: NotificationTapPayload[] = [];
    setNotificationTapHandler((payload) => {
      received.push(payload);
    });

    const listener = actionListener as
      | ((event: NotificationActionEvent) => void)
      | null;
    if (!listener) {
      throw new Error("expected Electron action listener");
    }
    listener({
      kind: "click",
      category: "notificationIntent",
      conversationId: "conv-electron",
      deliveryId: "delivery-electron",
      identity,
    });
    await flushTapQueue();

    expect(received).toEqual([
      {
        conversationId: "conv-electron",
        sourceEventName: "electron:notificationIntent:click",
        deliveryId: "delivery-electron",
        identity,
      },
    ]);
    expect(show).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  test("retries Electron action registration after a rejected preload", async () => {
    const identity = testIdentity();
    let actionListener: ((event: NotificationActionEvent) => void) | null =
      null;
    const show = mock(async (_payload: ShowNotificationPayload) => ({
      success: true,
    }));
    const onAction = mock(
      (
        _listener: (event: NotificationActionEvent) => void,
      ): (() => void) | Promise<never> =>
        () => {},
    );
    onAction.mockImplementationOnce(async () => {
      throw new Error("preload unavailable");
    });
    onAction.mockImplementationOnce((listener) => {
      actionListener = listener;
      return () => {};
    });
    (window as unknown as { vellum?: unknown }).vellum = {
      platform: "electron",
      notifications: { show, onAction },
    };
    const received: NotificationTapPayload[] = [];
    const handler = (payload: NotificationTapPayload) => {
      received.push(payload);
    };

    setNotificationTapHandler(handler);
    await new Promise((resolve) => setTimeout(resolve, 0));
    setNotificationTapHandler(handler);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onAction).toHaveBeenCalledTimes(2);
    const listener = actionListener as
      | ((event: NotificationActionEvent) => void)
      | null;
    if (!listener) {
      throw new Error("expected retried Electron action listener");
    }
    listener({
      kind: "action",
      category: "notificationIntent",
      conversationId: "conv-retry",
      identity,
    });
    await flushTapQueue();

    expect(received).toEqual([
      expect.objectContaining({
        conversationId: "conv-retry",
        identity,
      }),
    ]);
    expect(show).not.toHaveBeenCalled();
  });

  test("forwards Capacitor extra through the common dispatcher", async () => {
    const identity = testIdentity();
    const received: NotificationTapPayload[] = [];
    setNotificationTapHandler((payload) => {
      received.push(payload);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const listener = localActionListener;
    if (!listener) {
      throw new Error("expected Capacitor action listener");
    }
    const tapPayload: NotificationTapPayload = {
      conversationId: "conv-native",
      sourceEventName: "reminder.fired",
      deliveryId: "delivery-native",
      identity,
    };
    listener({ notification: { extra: tapPayload } });
    await flushTapQueue();

    expect(received).toEqual([tapPayload]);
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  test("retries Capacitor action registration after a bridge failure", async () => {
    addLocalListenerMock.mockRejectedValueOnce(
      new Error("native listener unavailable"),
    );
    const received: NotificationTapPayload[] = [];
    const handler = (payload: NotificationTapPayload) => {
      received.push(payload);
    };

    setNotificationTapHandler(handler);
    await new Promise((resolve) => setTimeout(resolve, 0));
    setNotificationTapHandler(handler);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(addLocalListenerMock).toHaveBeenCalledTimes(2);
    const listener = localActionListener;
    if (!listener) {
      throw new Error("expected retried Capacitor action listener");
    }
    listener({
      notification: {
        extra: {
          conversationId: "conv-native-retry",
          sourceEventName: "reminder.fired",
        },
      },
    });
    await flushTapQueue();

    expect(received).toEqual([
      expect.objectContaining({ conversationId: "conv-native-retry" }),
    ]);
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  test("browser onclick dispatches original scoped metadata only once", async () => {
    nativePlatform = false;
    const identity = testIdentity();
    const publication = beginNotificationIdentityPublication(identity);
    publishPreparedNotificationIdentity(publication, {
      name: "Assistant",
      nameProvenance: "identity-store",
      avatar: {
        avatarBase64: "iVBORw==",
        avatarHash: "d".repeat(64),
      },
    });
    useClientFeatureFlagStore.setState({ localNotificationAvatar: true });
    const received: NotificationTapPayload[] = [];
    const createdNotifications: Array<{
      onclick: (() => void) | null;
      close: () => void;
      options?: NotificationOptions;
    }> = [];
    let notificationCount = 0;
    const originalNotification = globalThis.Notification;
    class TestNotification {
      static permission: NotificationPermission = "granted";
      static requestPermission = async (): Promise<NotificationPermission> =>
        "granted";
      onclick: (() => void) | null = null;
      close = mock(() => {});
      options?: NotificationOptions;

      constructor(_title: string, options?: NotificationOptions) {
        notificationCount += 1;
        this.options = options;
        createdNotifications.push(this);
      }
    }
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: TestNotification,
    });
    try {
      setNotificationTapHandler((payload) => {
        received.push(payload);
      });
      await postLocalNotification({
        ...baseArgs,
        identity,
        deepLinkMetadata: { conversationId: "conv-browser" },
      });

      const notification = createdNotifications[0];
      if (!notification?.onclick) {
        throw new Error("expected browser notification click handler");
      }
      notification.onclick();
      await flushTapQueue();

      expect(received).toEqual([
        expect.objectContaining({
          conversationId: "conv-browser",
          sourceEventName: "reminder.fired",
          deliveryId: "delivery-1",
          identity,
        }),
      ]);
      expect(notification.options?.icon).toBe("data:image/png;base64,iVBORw==");
      expect(notification.options?.data).toMatchObject({ identity });
      expect(notificationCount).toBe(1);
      expect(scheduleMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "Notification", {
        configurable: true,
        value: originalNotification,
      });
    }
  });
});
