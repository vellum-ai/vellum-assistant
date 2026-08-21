import { beforeEach, expect, mock, test } from "bun:test";

import {
  PERMISSIONS_GET_STATE,
  PERMISSIONS_OPEN_SETTINGS,
  TEXT_INSERT,
} from "@vellumai/ipc-contract";

type Handler = (args: unknown[]) => unknown;

const handlers = new Map<string, Handler>();
const openExternal = mock(async () => undefined);
const helperCall = mock(async (method: string) => {
  if (method === "permissions.state") {
    return {
      microphone: "granted",
      speechRecognition: "denied",
      notifications: "granted",
    };
  }
  return { status: "inserted", reason: null };
});

mock.module("electron", () => ({
  app: {
    on: mock(() => undefined),
    quit: mock(() => undefined),
    relaunch: mock(() => undefined),
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  shell: { openExternal },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
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
  helperCall.mockClear();
  openExternal.mockClear();
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

  expect(openExternal).toHaveBeenCalledWith(
    "ms-settings:privacy-graphicscaptureprogrammatic",
  );
});
