/**
 * `postLocalNotification` native-branch behavior, focused on the
 * remote-push dedup skip: the local banner is scheduled whenever
 * `remotePushDispatched` is absent or false; it is skipped only when the
 * daemon confirmed an accepted remote push, this device holds a
 * session-confirmed APNs registration, and the app was hidden when the
 * intent arrived (the APNs banner covers that case).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── host platform guards ─────────────────────────────────────────────────────
//
// Force the native (Capacitor) branch: `isNativePlatform` reports false
// under happy-dom, and the Electron branch would return before reaching
// the code under test.

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => false,
}));
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => true,
}));

// ── push-registration read-only helpers ──────────────────────────────────────
//
// Mocked as pure flags; the helpers' own behavior is covered by
// push-registration.test.ts.

let sessionConfirmedAssistantId: string | null = null;
mock.module("@/runtime/push-registration", () => ({
  hasSessionConfirmedRemotePushRegistration: (assistantId: string) =>
    sessionConfirmedAssistantId === assistantId,
}));

// ── @capacitor/local-notifications ───────────────────────────────────────────

interface ScheduleArg {
  notifications: Array<{ id: number; title: string; body: string }>;
}
const scheduleMock = mock(async (_arg: ScheduleArg) => {});
mock.module("@capacitor/local-notifications", () => ({
  LocalNotifications: {
    checkPermissions: async () => ({ display: "granted" }),
    requestPermissions: async () => ({ display: "granted" }),
    schedule: scheduleMock,
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

const { postLocalNotification } = await import("@/runtime/notifications");

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
  sessionConfirmedAssistantId = null;
  scheduleMock.mockClear();
  ackMock.mockClear();
  ackArgs.length = 0;
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

  test("field absent (older daemon): schedules even when hidden", async () => {
    sessionConfirmedAssistantId = "assistant-1";
    setVisibility("hidden");

    await postLocalNotification({ ...baseArgs });

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
});
