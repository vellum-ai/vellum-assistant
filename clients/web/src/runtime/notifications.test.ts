/**
 * `postLocalNotification` native-branch behavior, focused on the
 * remote-push dedup skip: the local banner is scheduled whenever
 * `remotePushDispatched` is absent or false; it is skipped only when the
 * daemon confirmed an accepted remote push, this device holds a
 * session-confirmed APNs registration, and the app was hidden when the
 * intent arrived (the APNs banner covers that case).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ShowNotificationPayload } from "@vellumai/ipc-contract";

// ── host platform guards ─────────────────────────────────────────────────────
//
// Force the native (Capacitor) branch: `isNativePlatform` reports false
// under happy-dom, and the Electron branch would return before reaching
// the code under test.

let electronHost = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => electronHost,
}));
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => true,
}));
let nativeAndroid = false;
mock.module("@/runtime/platform-detection", () => ({
  isNativeAndroid: () => nativeAndroid,
}));

// ── push-registration read-only helpers ──────────────────────────────────────
//
// Mocked as pure flags; the helpers' own behavior is covered by
// push-registration.test.ts.

let sessionConfirmedAssistantId: string | null = null;
mock.module("@/runtime/push-registration", () => ({
  hasSessionConfirmedRemotePushRegistration: (assistantId: string) =>
    sessionConfirmedAssistantId === assistantId,
  extractPushConversationId: (data: Record<string, unknown>) =>
    typeof data.conversationId === "string" ? data.conversationId : undefined,
}));

const ensureAndroidAlertsChannelMock = mock(async () => {});
mock.module("@/runtime/android-notification-channels", () => ({
  ANDROID_ALERTS_CHANNEL_ID: "vellum-alerts",
  ensureAndroidAlertsChannel: ensureAndroidAlertsChannelMock,
}));
mock.module("@/i18n", () => ({
  t: (key: string) =>
    key === "localNotification.goToConversation"
      ? "Go to Conversation"
      : key,
}));

// ── @capacitor/local-notifications ───────────────────────────────────────────

interface ScheduleArg {
  notifications: Array<{
    id: number;
    title: string;
    body: string;
    channelId?: string;
    actionTypeId?: string;
  }>;
}
interface RegisterActionTypesArg {
  types: Array<{
    id: string;
    actions: Array<{ id: string; title: string; foreground?: boolean }>;
  }>;
}
const scheduleMock = mock(async (_arg: ScheduleArg) => {});
const registerActionTypesMock = mock(async (_arg: RegisterActionTypesArg) => {});
mock.module("@capacitor/local-notifications", () => ({
  LocalNotifications: {
    checkPermissions: async () => ({ display: "granted" }),
    requestPermissions: async () => ({ display: "granted" }),
    schedule: scheduleMock,
    registerActionTypes: registerActionTypesMock,
    addListener: async () => ({ remove: async () => {} }),
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
  notificationintentresultPost: ackMock,
}));

const {
  NOTIFICATION_INTENT_ACTION_TYPE_ID,
  NOTIFICATION_INTENT_VIEW_ACTION_ID,
  postForegroundRemotePush,
  postLocalNotification,
  __resetNotificationsStateForTests,
} = await import("@/runtime/notifications");
const { clearNotificationAvatar, setNotificationAvatar } =
  await import("@/runtime/notification-avatar");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
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

beforeEach(() => {
  electronHost = false;
  nativeAndroid = false;
  sessionConfirmedAssistantId = null;
  scheduleMock.mockClear();
  registerActionTypesMock.mockClear();
  ackMock.mockClear();
  ackArgs.length = 0;
  ensureAndroidAlertsChannelMock.mockClear();
  __resetNotificationsStateForTests();
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

    await postLocalNotification({ ...baseArgs, remotePushDispatched: true, remotePushPlatforms: [] });

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
    expect(
      scheduleMock.mock.calls[0]?.[0].notifications[0]?.actionTypeId,
    ).toBe(NOTIFICATION_INTENT_ACTION_TYPE_ID);
  });

  test("registers the action type even when the banner has no conversation", async () => {
    await postLocalNotification(baseArgs);

    expect(registerActionTypesMock).toHaveBeenCalledTimes(1);
    expect(
      scheduleMock.mock.calls[0]?.[0].notifications[0]?.actionTypeId,
    ).toBeUndefined();
  });
});

// ── Electron branch: the assistant as the notification's sender ─────────────

describe("postLocalNotification sender (Electron branch)", () => {
  const AVATAR = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const AVATAR_HASH = "b".repeat(64);
  const showMock = mock(async (_payload: ShowNotificationPayload) => ({
    success: true,
  }));

  beforeEach(() => {
    electronHost = true;
    showMock.mockClear();
    clearNotificationAvatar();
    useAssistantIdentityStore
      .getState()
      .setIdentity("Aria", "1.0.0", "assistant-1");
    useClientFeatureFlagStore.setState({ pushAvatarSender: true });
    (window as unknown as { vellum?: unknown }).vellum = {
      notifications: { show: showMock },
    };
  });

  afterEach(() => {
    clearNotificationAvatar();
    useAssistantIdentityStore.getState().clearIdentity();
    useClientFeatureFlagStore.setState({ pushAvatarSender: false });
    delete (window as unknown as { vellum?: unknown }).vellum;
  });

  test("attaches the held avatar, the assistant's name and its id", async () => {
    setNotificationAvatar("assistant-1", AVATAR, AVATAR_HASH);

    await postLocalNotification(baseArgs);

    expect(showMock).toHaveBeenCalledTimes(1);
    expect(showMock.mock.calls[0]?.[0].sender).toEqual({
      id: "assistant-1",
      name: "Aria",
      avatarBase64: "iVBORw==",
      avatarHash: AVATAR_HASH,
    });
  });

  test("sends no sender key at all when no avatar is held", async () => {
    await postLocalNotification(baseArgs);

    const payload = showMock.mock.calls[0]?.[0] ?? {};
    expect("sender" in payload).toBe(false);
  });

  test("sends no sender when the assistant has no name yet", async () => {
    setNotificationAvatar("assistant-1", AVATAR, AVATAR_HASH);
    useAssistantIdentityStore.getState().clearIdentity();

    await postLocalNotification(baseArgs);

    expect(showMock.mock.calls[0]?.[0].sender).toBeUndefined();
  });

  test("sends no sender when the held avatar belongs to another assistant", async () => {
    setNotificationAvatar("assistant-2", AVATAR, AVATAR_HASH);

    await postLocalNotification(baseArgs);

    expect(showMock.mock.calls[0]?.[0].sender).toBeUndefined();
  });

  test("sends no sender when the hydrated identity belongs to another assistant", async () => {
    // The name and the face come from stores written at different moments in
    // an assistant switch, so a name that is not this assistant's is refused
    // rather than paired with a face that is.
    setNotificationAvatar("assistant-1", AVATAR, AVATAR_HASH);
    useAssistantIdentityStore
      .getState()
      .setIdentity("Nova", "1.0.0", "assistant-2");

    await postLocalNotification(baseArgs);

    expect(showMock.mock.calls[0]?.[0].sender).toBeUndefined();
  });

  test("sends no sender when the notification is for a different assistant", async () => {
    setNotificationAvatar("assistant-1", AVATAR, AVATAR_HASH);

    await postLocalNotification({ ...baseArgs, assistantId: "assistant-9" });

    expect(showMock.mock.calls[0]?.[0].sender).toBeUndefined();
  });

  test("sends no sender while push-avatar-sender is off", async () => {
    // The holder outlives the flag, so the send path checks it again rather
    // than trusting that the hook has emptied it.
    setNotificationAvatar("assistant-1", AVATAR, AVATAR_HASH);
    useClientFeatureFlagStore.setState({ pushAvatarSender: false });

    await postLocalNotification(baseArgs);

    expect(showMock.mock.calls[0]?.[0].sender).toBeUndefined();
  });
});
