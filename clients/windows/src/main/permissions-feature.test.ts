import { beforeEach, expect, mock, test } from "bun:test";

import {
  PERMISSIONS_GET_STATE,
  PERMISSIONS_OPEN_SETTINGS,
  PERMISSIONS_REQUEST,
  TEXT_INSERT,
} from "@vellumai/ipc-contract";

type Handler = (args: unknown[]) => unknown;

const handlers = new Map<string, Handler>();
const openExternal = mock(async () => undefined);
const mediaStatus = mock((_kind: string): string => "granted");
let notificationOutcome: "show" | "failed" = "show";

class FakeNotification {
  static isSupported = () => true;
  private listeners = new Map<string, () => void>();
  once(event: string, listener: () => void) {
    this.listeners.set(event, listener);
    return this;
  }
  show() {
    this.listeners.get(notificationOutcome)?.();
  }
}
const defaultHelperCall = async (method: string): Promise<unknown> => {
  if (method === "permissions.state") {
    return {
      microphone: "granted",
      speechRecognition: "denied",
      notifications: "granted",
    };
  }
  return { status: "inserted", reason: null };
};
const helperCall = mock(defaultHelperCall);

let onFocus: (() => void) | null = null;

mock.module("electron", () => ({
  app: {
    on: mock((event: string, listener: () => void) => {
      if (event === "browser-window-focus") {
        onFocus = listener;
      }
    }),
    quit: mock(() => undefined),
    relaunch: mock(() => undefined),
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  shell: { openExternal },
  systemPreferences: { getMediaAccessStatus: mediaStatus },
  Notification: FakeNotification,
}));
mock.module("./ipc.client", () => ({
  handle: (channel: string, _schema: unknown, handler: Handler) => {
    handlers.set(channel, handler);
  },
}));
mock.module("./logger", () => ({ default: { warn: mock(() => undefined) } }));
mock.module("./main-window", () => ({ current: () => null }));
mock.module("./windows-helper", () => ({
  getWindowsHelperClient: () => ({ call: helperCall }),
}));

const { default: permissionsFeature } = await import("./features/permissions");

beforeEach(() => {
  handlers.clear();
  helperCall.mockReset();
  helperCall.mockImplementation(defaultHelperCall);
  openExternal.mockClear();
  mediaStatus.mockReset();
  mediaStatus.mockImplementation(() => "granted");
  notificationOutcome = "show";
  permissionsFeature.install({} as never);
});

test("uses the Windows helper for permission states and text insertion", async () => {
  await expect(handlers.get(PERMISSIONS_GET_STATE)!([])).resolves.toMatchObject(
    {
      microphone: { status: "granted" },
      speechRecognition: { status: "denied" },
      notifications: { status: "granted" },
    },
  );
  await expect(handlers.get(TEXT_INSERT)!(["hello"])).resolves.toEqual({
    status: "inserted",
  });

  expect(helperCall).toHaveBeenCalledWith("permissions.state");
  expect(helperCall).toHaveBeenCalledWith("text.insert", { text: "hello" });
});

test("reports Windows-only applicability and opens screen capture settings", async () => {
  await expect(handlers.get(PERMISSIONS_GET_STATE)!([])).resolves.toMatchObject(
    {
      accessibility: { status: "not-applicable" },
      screen: {
        status: "unknown",
        canOpenSettings: true,
      },
      inputMonitoring: { status: "not-applicable" },
      automation: { status: "not-applicable" },
    },
  );

  await handlers.get(PERMISSIONS_OPEN_SETTINGS)!(["screen"]);

  expect(mediaStatus).not.toHaveBeenCalledWith("screen");
  expect(openExternal).toHaveBeenCalledWith(
    "ms-settings:privacy-graphicscaptureprogrammatic",
  );
});

test("reports helper screen capture consent with a settings link", async () => {
  helperCall.mockImplementation(async () => ({ screen: "denied" }));
  await expect(handlers.get(PERMISSIONS_GET_STATE)!([])).resolves.toMatchObject(
    { screen: { status: "denied", canRequest: false, canOpenSettings: true } },
  );
});

test("requests notifications by probing instead of opening settings", async () => {
  helperCall.mockImplementation(async () => ({ notifications: "unknown" }));
  await expect(handlers.get(PERMISSIONS_GET_STATE)!([])).resolves.toMatchObject(
    { notifications: { status: "unknown", canRequest: true } },
  );

  notificationOutcome = "failed";
  await expect(
    handlers.get(PERMISSIONS_REQUEST)!(["notifications"]),
  ).resolves.toMatchObject({ status: "denied", canOpenSettings: true });
  expect(openExternal).not.toHaveBeenCalled();

  // A Settings change seen by the helper supersedes the probe result.
  helperCall.mockImplementation(async () => ({ notifications: "granted" }));
  await expect(handlers.get(PERMISSIONS_GET_STATE)!([])).resolves.toMatchObject(
    { notifications: { status: "granted", canRequest: false } },
  );
});

test("regaining focus drops the notification probe result", async () => {
  helperCall.mockImplementation(async () => ({ notifications: "granted" }));
  notificationOutcome = "failed";
  await expect(
    handlers.get(PERMISSIONS_REQUEST)!(["notifications"]),
  ).resolves.toMatchObject({ status: "denied" });

  onFocus!();
  await expect(handlers.get(PERMISSIONS_GET_STATE)!([])).resolves.toMatchObject(
    { notifications: { status: "granted" } },
  );
});

test("requesting a settings-only kind opens its settings page", async () => {
  await handlers.get(PERMISSIONS_REQUEST)!(["microphone"]);
  expect(openExternal).toHaveBeenCalledWith("ms-settings:privacy-microphone");
});
