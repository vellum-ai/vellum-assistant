import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { z } from "zod";

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
let electronNotificationOptions: {
  title: string;
  body: string;
  silent: boolean;
} | null = null;

type ElectronListener = () => void;

class FakeElectronNotification {
  private listeners = new Map<string, ElectronListener>();

  constructor(options: { title: string; body: string; silent: boolean }) {
    electronNotificationsConstructed += 1;
    electronNotificationOptions = options;
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
  app: {
    isPackaged: false,
    getPath: () => "/tmp/vellum-permissions-test",
    relaunch: () => undefined,
    quit: () => undefined,
    on: () => undefined,
  },
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

interface HandleRegistration {
  channel: string;
  schema: z.ZodType<unknown[]>;
  fn: (args: unknown[], event: { sender: unknown }) => unknown;
}

const handleRegistrations: HandleRegistration[] = [];
mock.module("./ipc", () => ({
  handle: (
    channel: string,
    schema: z.ZodType<unknown[]>,
    fn: (args: unknown[], event: { sender: unknown }) => unknown,
  ) => {
    handleRegistrations.push({ channel, schema, fn });
  },
}));

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
let authorizationRequest = async (): Promise<NotifierAuthorizationResult | null> =>
  authorizationResult;
let preparedSenderCurrent = true;
let nativeShowError: Error | null = null;
const nativePosts: NotifierRequest[] = [];
const resolveNotificationAvatarPath = mock(() => "/tmp/avatar.png");

mock.module("@vellumai/electron-desktop/notification-avatar-path", () => ({
  resolveNotificationAvatarPath,
}));

mock.module("@vellumai/electron-desktop/notifications", () => ({
  isPreparedNotificationSenderCurrent: (identity: { scopeId: string }) =>
    preparedSenderCurrent && /^scope:v1:[a-f0-9]{64}$/.test(identity.scopeId),
}));

mock.module("./notifier", () => ({
  getNotifier: () => notifier,
  isNotifierSupported: () => notifier?.isSupported() ?? false,
  requestNotifierAuthorization: () => authorizationRequest(),
}));

const { PermissionsService, installPermissionsService } = await import(
  "./permissions-service"
);

const nativeNotifier = (isSupported = true): Notifier => ({
  isSupported: () => isSupported,
  requestAuthorization: () => undefined,
  registerCategories: () => undefined,
  restoreDelegate: () => undefined,
  show: (request) => {
    if (nativeShowError) {
      throw nativeShowError;
    }
    nativePosts.push(request);
  },
});

describe("notification permission requests", () => {
  beforeEach(() => {
    electronNotificationsConstructed = 0;
    electronIsSupportedCalls = 0;
    electronSupported = true;
    electronNotificationOptions = null;
    nativePosts.length = 0;
    notifier = nativeNotifier();
    authorizationResult = { granted: true };
    authorizationRequest = async () => authorizationResult;
    preparedSenderCurrent = true;
    nativeShowError = null;
    handleRegistrations.length = 0;
    resolveNotificationAvatarPath.mockClear();
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

  test("does not confirm an unknown native authorization outcome", async () => {
    authorizationResult = null;

    const item = await new PermissionsService().request("notifications");

    expect(item.status).toBe("unknown");
    expect(nativePosts).toHaveLength(0);
  });

  test("falls back to the Electron probe when the addon cannot notify", async () => {
    notifier = nativeNotifier(false);

    const item = await new PermissionsService().request("notifications");

    expect(item.status).toBe("granted");
    expect(electronNotificationsConstructed).toBe(1);
    expect(nativePosts.length).toBe(0);
  });

  test("posts a personalized confirmation for an exact prepared sender", async () => {
    const avatarPng = Buffer.from("avatar-bytes");
    const presentation = {
      presentation: "assistant" as const,
      identity: {
        scopeId: `scope:v1:${"a".repeat(64)}`,
        assistantId: "assistant-a",
        nativeSenderId: "native-a",
      },
      sender: {
        id: "native-a",
        name: "Alice",
        avatarBase64: avatarPng.toString("base64"),
        avatarHash: new Bun.CryptoHasher("sha256")
          .update(avatarPng)
          .digest("hex"),
      },
    };

    const item = await new PermissionsService().request(
      "notifications",
      undefined,
      presentation,
    );

    expect(item.status).toBe("granted");
    expect(nativePosts).toHaveLength(1);
    expect(nativePosts[0]).toMatchObject({
      title: "Alice",
      body: "You’re all set. I can send you notifications here.",
      categoryId: "",
      actions: [],
      sender: {
        id: "native-a",
        name: "Alice",
        avatarPngPath: "/tmp/avatar.png",
        conversationId: "native-a",
      },
    });
    expect(nativePosts[0]!.subtitle).toBeUndefined();
  });

  test("degrades to one plain confirmation when the captured scope changes", async () => {
    let settleAuthorization:
      | ((result: NotifierAuthorizationResult) => void)
      | undefined;
    authorizationRequest = () =>
      new Promise((resolve) => {
        settleAuthorization = resolve;
      });
    const presentation = {
      presentation: "assistant" as const,
      identity: {
        scopeId: `scope:v1:${"a".repeat(64)}`,
        assistantId: "assistant-a",
        nativeSenderId: "native-a",
      },
      sender: {
        id: "native-a",
        name: "Alice",
        avatarBase64: Buffer.from("avatar-bytes").toString("base64"),
        avatarHash: "a".repeat(64),
      },
    };

    const request = new PermissionsService().request(
      "notifications",
      undefined,
      presentation,
    );
    await Promise.resolve();
    preparedSenderCurrent = false;
    settleAuthorization?.({ granted: true });
    const item = await request;

    expect(item.status).toBe("granted");
    expect(nativePosts).toHaveLength(1);
    expect(nativePosts[0]).toMatchObject({
      title: "Vellum",
      body: "Notifications are enabled.",
    });
    expect(nativePosts[0]!.sender).toBeUndefined();
    expect(resolveNotificationAvatarPath).not.toHaveBeenCalled();
  });

  test("keeps a granted result when the confirmation fails", async () => {
    nativeShowError = new Error("notification failed");

    const item = await new PermissionsService().request("notifications");

    expect(item.status).toBe("granted");
    expect(nativePosts).toHaveLength(0);
  });

  test("accepts old request calls and drops malformed presentation", async () => {
    installPermissionsService();
    const registration = handleRegistrations.find(
      ({ channel }) => channel === "vellum:permissions:request",
    );
    expect(registration).toBeDefined();

    const oldArgs = registration!.schema.parse(["notifications"]);
    expect(oldArgs).toEqual(["notifications"]);

    const malformedArgs = registration!.schema.parse([
      "notifications",
      {
        presentation: "assistant",
        identity: {
          scopeId: `scope:v1:${"a".repeat(64)}`,
          assistantId: "assistant-a",
          nativeSenderId: "native-a",
        },
        sender: { id: "native-a", name: "Alice" },
      },
    ]);
    await registration!.fn(malformedArgs, { sender: {} });

    expect(nativePosts).toHaveLength(1);
    expect(nativePosts[0]).toMatchObject({
      title: "Vellum",
      body: "Notifications are enabled.",
    });
    expect(nativePosts[0]!.sender).toBeUndefined();
  });

  test("degrades a raw-scope sender to a plain confirmation", async () => {
    installPermissionsService();
    const registration = handleRegistrations.find(
      ({ channel }) => channel === "vellum:permissions:request",
    );
    const avatarPng = Buffer.from("avatar-bytes");
    const args = registration!.schema.parse([
      "notifications",
      {
        presentation: "assistant",
        identity: {
          scopeId: "raw-scope",
          assistantId: "assistant-a",
          nativeSenderId: "native-a",
        },
        sender: {
          id: "native-a",
          name: "Alice",
          avatarBase64: avatarPng.toString("base64"),
          avatarHash: new Bun.CryptoHasher("sha256")
            .update(avatarPng)
            .digest("hex"),
        },
      },
    ]);

    await registration!.fn(args, { sender: {} });

    expect(nativePosts).toHaveLength(1);
    expect(nativePosts[0]).toMatchObject({
      title: "Vellum",
      body: "Notifications are enabled.",
    });
    expect(nativePosts[0]!.sender).toBeUndefined();
    expect(resolveNotificationAvatarPath).not.toHaveBeenCalled();
  });

  test("keeps the Electron fallback probe plain with a captured sender", async () => {
    notifier = nativeNotifier(false);
    const avatarPng = Buffer.from("avatar-bytes");

    const item = await new PermissionsService().request(
      "notifications",
      undefined,
      {
        presentation: "assistant",
        identity: {
          scopeId: `scope:v1:${"a".repeat(64)}`,
          assistantId: "assistant-a",
          nativeSenderId: "native-a",
        },
        sender: {
          id: "native-a",
          name: "Alice",
          avatarBase64: avatarPng.toString("base64"),
          avatarHash: new Bun.CryptoHasher("sha256")
            .update(avatarPng)
            .digest("hex"),
        },
      },
    );

    expect(item.status).toBe("granted");
    expect(electronNotificationsConstructed).toBe(1);
    expect(electronNotificationOptions).toEqual({
      title: "Vellum",
      body: "Notifications are enabled.",
      silent: false,
    });
    expect(nativePosts).toHaveLength(0);
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
