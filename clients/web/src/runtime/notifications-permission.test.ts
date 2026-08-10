/**
 * `ensureNotificationPermission` concurrency, on the desktop-browser branch.
 *
 * The prompt is answered by a human who is — by construction — in another
 * app when the first notification intent lands, so intents keep arriving
 * while it sits open. They must queue behind that one prompt and post once
 * it resolves, rather than each resolving to `"prompt"` and dropping its
 * banner.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Force the desktop-browser branch: both guards must report false or
// `postLocalNotification` returns through Electron/Capacitor before it
// reaches the permission path.

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => false,
}));
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => false,
}));
mock.module("@/runtime/platform-detection", () => ({
  isNativeAndroid: () => false,
}));
mock.module("@/runtime/push-registration", () => ({
  hasSessionConfirmedRemotePushRegistration: () => false,
  extractPushConversationId: () => undefined,
}));
mock.module("@/runtime/android-notification-channels", () => ({
  ANDROID_ALERTS_CHANNEL_ID: "vellum-alerts",
  ensureAndroidAlertsChannel: async () => {},
}));

interface AckArg {
  path: { assistant_id: string };
  body: { deliveryId: string; success: boolean; errorMessage?: string };
  throwOnError: boolean;
}
const ackArgs: AckArg[] = [];
mock.module("@/generated/daemon/sdk.gen", () => ({
  notificationintentresultPost: async (arg: AckArg) => {
    ackArgs.push(arg);
    return { data: undefined, error: undefined };
  },
}));

const { postLocalNotification, __resetNotificationsStateForTests } =
  await import("@/runtime/notifications");

// ── Notification stub ────────────────────────────────────────────────────────
//
// happy-dom ships no Notification constructor. The stub records each posted
// banner and exposes a manually-settled `requestPermission` so a prompt can
// be held open across several intents.

const posted: string[] = [];
let permission: NotificationPermission = "default";
let settlePrompt: ((value: NotificationPermission) => void) | undefined;
let promptCallCount = 0;

class NotificationStub {
  onclick: (() => void) | null = null;
  constructor(title: string, _options?: NotificationOptions) {
    posted.push(title);
  }
  close(): void {}
  static get permission(): NotificationPermission {
    return permission;
  }
  static requestPermission(): Promise<NotificationPermission> {
    promptCallCount += 1;
    return new Promise<NotificationPermission>((resolve) => {
      settlePrompt = (value) => {
        permission = value;
        resolve(value);
      };
    });
  }
}

beforeEach(() => {
  posted.length = 0;
  ackArgs.length = 0;
  permission = "default";
  settlePrompt = undefined;
  promptCallCount = 0;
  __resetNotificationsStateForTests();
  (globalThis as { Notification?: unknown }).Notification = NotificationStub;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
});

/**
 * Let the in-flight calls reach the prompt. `requestPermission` is called
 * several awaits deep, so `settlePrompt` is not assigned synchronously.
 */
const reachPrompt = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const intent = (deliveryId: string, title: string) => ({
  title,
  body: "This is a test notification",
  sourceEventName: "assistant.share",
  deliveryId,
  assistantId: "assistant-1",
});

describe("ensureNotificationPermission single-flight", () => {
  test("intents arriving during an unanswered prompt post once it is granted", async () => {
    // Three intents land back-to-back while the user is in another app.
    const inFlight = [
      postLocalNotification(intent("d1", "Test 1")),
      postLocalNotification(intent("d2", "Test 2")),
      postLocalNotification(intent("d3", "Test 3")),
    ];

    await reachPrompt();

    // Nothing can post yet — the prompt is still open.
    expect(posted).toEqual([]);

    // The user returns and clicks Allow.
    settlePrompt?.("granted");
    await Promise.all(inFlight);

    expect(posted).toEqual(["Test 1", "Test 2", "Test 3"]);
    // One prompt for all three, not one per intent.
    expect(promptCallCount).toBe(1);
    expect(ackArgs.map((a) => a.body)).toEqual([
      { deliveryId: "d1", success: true },
      { deliveryId: "d2", success: true },
      { deliveryId: "d3", success: true },
    ]);
  });

  test("a denial is reported as such and never re-prompts", async () => {
    const first = postLocalNotification(intent("d1", "Test 1"));
    await reachPrompt();
    settlePrompt?.("denied");
    await first;

    await postLocalNotification(intent("d2", "Test 2"));

    expect(posted).toEqual([]);
    expect(promptCallCount).toBe(1);
    expect(ackArgs.map((a) => a.body)).toEqual([
      {
        deliveryId: "d1",
        success: false,
        errorMessage: "Notification authorization denied",
      },
      {
        deliveryId: "d2",
        success: false,
        errorMessage: "Notification authorization denied",
      },
    ]);
  });

  test("an already-granted permission posts without prompting", async () => {
    permission = "granted";

    await postLocalNotification(intent("d1", "Test 1"));

    expect(posted).toEqual(["Test 1"]);
    expect(promptCallCount).toBe(0);
  });
});
