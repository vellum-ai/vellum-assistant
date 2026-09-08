import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Notifier,
  NotifierAuthorizationResult,
  NotifierRequest,
} from "./notifier";

// Counted rather than asserted on construction: the whole point of the native
// path is that Electron's presenter is never built, and building it is what
// hands Electron the notification center's delegate.
let electronNotificationsConstructed = 0;
let electronIsSupportedCalls = 0;
let electronSupported = true;

type ElectronListener = () => void;

class FakeElectronNotification {
  private listeners = new Map<string, ElectronListener>();

  constructor() {
    electronNotificationsConstructed += 1;
  }

  static isSupported(): boolean {
    electronIsSupportedCalls += 1;
    return electronSupported;
  }

  once(event: string, listener: ElectronListener): this {
    this.listeners.set(event, listener);
    return this;
  }

  show(): void {
    this.listeners.get("show")?.();
  }
}

mock.module("electron", () => ({
  app: { isPackaged: false, relaunch: () => undefined, quit: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: FakeElectronNotification,
  desktopCapturer: { getSources: async () => [] },
  shell: { openExternal: async () => undefined },
  systemPreferences: {
    isTrustedAccessibilityClient: () => true,
    askForMediaAccess: async () => true,
    getMediaAccessStatus: () => "granted",
  },
}));

mock.module("./ipc", () => ({ handle: () => undefined }));

mock.module("./logger", () => ({
  default: { info: () => undefined, warn: () => undefined },
}));

mock.module("./appleScriptExecutor", () => ({
  runAppleScript: async () => "",
}));

mock.module("./hotkey-helper", () => ({
  queryFreshMacHelperPermission: async () => "granted",
  queryMacHelperPermission: async () => "granted",
  requestMacHelperInputMonitoringPermission: async () => undefined,
  requestMacHelperSpeechRecognitionPermission: async () => undefined,
}));

let notifier: Notifier | null = null;
let authorizationResult: NotifierAuthorizationResult | null = { granted: true };
const nativePosts: NotifierRequest[] = [];

mock.module("./notifier", () => ({
  getNotifier: () => notifier,
  isNotifierSupported: () => notifier?.isSupported() ?? false,
  requestNotifierAuthorization: async () => authorizationResult,
}));

const { PermissionsService } = await import("./permissions-service");

const nativeNotifier = (isSupported = true): Notifier => ({
  isSupported: () => isSupported,
  requestAuthorization: () => undefined,
  registerCategories: () => undefined,
  restoreDelegate: () => undefined,
  show: (request) => {
    nativePosts.push(request);
  },
});

describe("notification permission requests", () => {
  beforeEach(() => {
    electronNotificationsConstructed = 0;
    electronIsSupportedCalls = 0;
    electronSupported = true;
    nativePosts.length = 0;
    notifier = nativeNotifier();
    authorizationResult = { granted: true };
  });

  test("prompts through the addon and leaves electron.Notification alone", async () => {
    const item = await new PermissionsService().request("notifications");

    expect(item.status).toBe("granted");
    expect(electronNotificationsConstructed).toBe(0);
    expect(electronIsSupportedCalls).toBe(0);
  });

  // The Electron probe posts a notification to learn its answer, so a granted
  // permission always ends in a banner; the addon answers without posting one.
  test("posts the same confirmation banner the Electron probe leaves behind", async () => {
    await new PermissionsService().request("notifications");

    expect(nativePosts.length).toBe(1);
    expect(nativePosts[0]!.body).toBe("Notifications are enabled.");
    expect(nativePosts[0]!.actions).toEqual([]);
    expect(electronNotificationsConstructed).toBe(0);
  });

  test("records a refused prompt as denied", async () => {
    authorizationResult = { granted: false, error: "not authorized" };

    const item = await new PermissionsService().request("notifications");

    expect(item.status).toBe("denied");
    expect(electronNotificationsConstructed).toBe(0);
    expect(nativePosts.length).toBe(0);
  });

  test("falls back to the Electron probe when the addon cannot notify", async () => {
    notifier = nativeNotifier(false);

    const item = await new PermissionsService().request("notifications");

    expect(item.status).toBe("granted");
    expect(electronNotificationsConstructed).toBe(1);
    expect(nativePosts.length).toBe(0);
  });

  test("falls back to the Electron probe when the addon is unavailable", async () => {
    notifier = null;

    const item = await new PermissionsService().request("notifications");

    expect(item.status).toBe("granted");
    expect(electronNotificationsConstructed).toBe(1);
  });

  test("reports restricted only when neither path can post", async () => {
    notifier = nativeNotifier(false);
    electronSupported = false;

    const item = await new PermissionsService().request("notifications");

    expect(item.status).toBe("restricted");
    expect(electronNotificationsConstructed).toBe(0);
  });
});
