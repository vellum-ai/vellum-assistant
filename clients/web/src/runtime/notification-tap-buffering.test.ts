/**
 * Notification taps that arrive before the renderer is listening.
 *
 * Clicking a banner while the app is closed is exactly when the user most
 * expects to land on the conversation, and exactly when no renderer is
 * subscribed: `tapHandler` is registered from a React effect at
 * `RootLayout`, long after the main process fires the click. Main buffers
 * those taps; this covers the renderer half — subscribe, drain, replay —
 * plus the local guard that keeps any path from dropping a tap silently.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { NotificationTapPayload } from "@/runtime/notifications";

// ── host platform guards ────────────────────────────────────────────────────
//
// Force the Electron branch: it is the one with a main-process buffer to
// drain, and the branch the desktop app actually takes.

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => true,
}));
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => false,
}));
mock.module("@/runtime/platform-detection", () => ({
  isNativeAndroid: () => false,
}));

const captureErrorMock = mock((_error: unknown, _context: unknown) => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

// ── the Electron bridge ─────────────────────────────────────────────────────

interface ActionEvent {
  kind: string;
  category: string;
  conversationId?: string;
  deliveryId?: string;
}

let actionCallback: ((event: ActionEvent) => void) | null = null;
let bufferedActions: ActionEvent[] = [];
let drainRejects = false;
let drainResolvers: Array<() => void> = [];
/** When true, `drainActions` waits for `releaseDrain()` before resolving. */
let drainDeferred = false;

const onActionMock = mock((cb: (event: ActionEvent) => void) => {
  actionCallback = cb;
  return () => {
    actionCallback = null;
  };
});
const drainActionsMock = mock(async (): Promise<ActionEvent[]> => {
  if (drainRejects) {
    throw new Error("drain failed");
  }
  if (drainDeferred) {
    await new Promise<void>((resolve) => drainResolvers.push(resolve));
  }
  return bufferedActions;
});

const releaseDrain = () => {
  for (const resolve of drainResolvers) {
    resolve();
  }
  drainResolvers = [];
};

Object.defineProperty(window, "vellum", {
  configurable: true,
  writable: true,
  value: {
    notifications: { onAction: onActionMock, drainActions: drainActionsMock },
  },
});

const { setNotificationTapHandler, __resetNotificationsStateForTests } =
  await import("@/runtime/notifications");

/** Let the drain promise chain settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const taps: NotificationTapPayload[] = [];
const record = (payload: NotificationTapPayload) => {
  taps.push(payload);
};

beforeEach(() => {
  taps.length = 0;
  bufferedActions = [];
  drainRejects = false;
  drainDeferred = false;
  drainResolvers = [];
  actionCallback = null;
  onActionMock.mockClear();
  drainActionsMock.mockClear();
  captureErrorMock.mockClear();
  __resetNotificationsStateForTests();
});

describe("draining taps buffered while the app was closed", () => {
  test("replays a buffered tap to the handler registered on mount", async () => {
    bufferedActions = [
      {
        kind: "click",
        category: "notificationIntent",
        conversationId: "conv-cold",
        deliveryId: "del-cold",
      },
    ];

    setNotificationTapHandler(record);
    await flush();

    expect(taps).toEqual([
      {
        conversationId: "conv-cold",
        sourceEventName: "electron:notificationIntent:click",
        deliveryId: "del-cold",
      },
    ]);
  });

  test("subscribes before draining so a tap landing between the two is not lost", async () => {
    // The live listener must already be attached when drain is issued.
    drainDeferred = true;
    setNotificationTapHandler(record);

    expect(onActionMock).toHaveBeenCalledTimes(1);
    expect(actionCallback).not.toBeNull();

    actionCallback!({
      kind: "click",
      category: "notificationIntent",
      conversationId: "conv-live",
    });
    releaseDrain();
    await flush();

    expect(taps.map((t) => t.conversationId)).toEqual(["conv-live"]);
  });

  test("replays every buffered tap in order", async () => {
    bufferedActions = [
      { kind: "click", category: "notificationIntent", conversationId: "c1" },
      { kind: "action", category: "toolConfirmation", conversationId: "c2" },
    ];

    setNotificationTapHandler(record);
    await flush();

    expect(taps.map((t) => t.conversationId)).toEqual(["c1", "c2"]);
    expect(taps.map((t) => t.sourceEventName)).toEqual([
      "electron:notificationIntent:click",
      "electron:toolConfirmation:action",
    ]);
  });

  test("an empty buffer dispatches nothing", async () => {
    setNotificationTapHandler(record);
    await flush();

    expect(taps).toHaveLength(0);
  });

  // A failed drain costs the launching tap; it must not take the live
  // listener down with it.
  test("a failed drain is reported and leaves live taps working", async () => {
    drainRejects = true;

    setNotificationTapHandler(record);
    await flush();

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock.mock.calls[0]![1]).toMatchObject({
      context: "notifications.drainActions",
    });

    actionCallback!({
      kind: "click",
      category: "notificationIntent",
      conversationId: "conv-after-failure",
    });
    expect(taps.map((t) => t.conversationId)).toEqual(["conv-after-failure"]);
  });

  test("drains once, not on every handler re-registration", async () => {
    setNotificationTapHandler(record);
    await flush();
    setNotificationTapHandler(record);
    await flush();

    expect(drainActionsMock).toHaveBeenCalledTimes(1);
    expect(onActionMock).toHaveBeenCalledTimes(1);
  });
});

describe("taps arriving with no handler registered", () => {
  test("a tap dispatched before registration is replayed, not dropped", async () => {
    // Register once to attach the platform listener, then simulate a tap
    // reaching the renderer while no handler is installed.
    setNotificationTapHandler(record);
    await flush();
    const liveCallback = actionCallback!;

    __resetNotificationsStateForTests();
    Object.defineProperty(window, "vellum", {
      configurable: true,
      writable: true,
      value: {
        notifications: {
          onAction: onActionMock,
          drainActions: drainActionsMock,
        },
      },
    });

    liveCallback({
      kind: "click",
      category: "notificationIntent",
      conversationId: "conv-orphan",
    });
    expect(taps).toHaveLength(0);

    setNotificationTapHandler(record);
    expect(taps.map((t) => t.conversationId)).toEqual(["conv-orphan"]);
  });

  test("a replayed tap is not delivered twice on a later registration", async () => {
    setNotificationTapHandler(record);
    await flush();
    const liveCallback = actionCallback!;

    __resetNotificationsStateForTests();
    liveCallback({
      kind: "click",
      category: "notificationIntent",
      conversationId: "conv-once",
    });

    setNotificationTapHandler(record);
    setNotificationTapHandler(record);

    expect(taps).toHaveLength(1);
  });
});
