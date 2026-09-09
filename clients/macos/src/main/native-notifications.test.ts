import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { NotificationCreateOptions } from "@vellumai/electron-desktop/notifications";

import type {
  NotifierCategory,
  NotifierEvent,
  NotifierRequest,
} from "./notifier";

const userDataDir = mkdtempSync(path.join(tmpdir(), "vellum-notif-avatars-"));

interface ElectronNotificationOptions {
  title: string;
  body: string;
  silent: boolean;
  actions: { type: "button"; text: string }[];
  icon?: unknown;
}

const electronNotifications: ElectronNotificationOptions[] = [];

class FakeElectronNotification {
  constructor(readonly options: ElectronNotificationOptions) {
    electronNotifications.push(options);
  }

  on(): this {
    return this;
  }

  show(): void {}
}

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
  },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: FakeElectronNotification,
  nativeImage: { createFromBuffer: (buffer: Buffer) => buffer },
}));

const warnings: unknown[][] = [];
mock.module("./logger", () => ({
  default: {
    info: () => undefined,
    warn: (...args: unknown[]) => warnings.push(args),
  },
}));

interface Call {
  request: NotifierRequest;
  emit: (event: NotifierEvent) => void;
}

const calls: Call[] = [];
const registered: NotifierCategory[][] = [];
let delegateReassertions = 0;
let notifierSupported = true;
let notifierPresent = true;
let showThrows = false;

mock.module("./notifier", () => ({
  registerNotifierCategories: (categories: NotifierCategory[]) => {
    registered.push(categories);
  },
  ensureNotifierDelegate: () => {
    delegateReassertions += 1;
  },
  isNotifierSupported: () => notifierPresent && notifierSupported,
  getNotifier: () =>
    notifierPresent
      ? {
          isSupported: () => notifierSupported,
          requestAuthorization: () => undefined,
          registerCategories: () => undefined,
          restoreDelegate: () => undefined,
          show: (
            request: NotifierRequest,
            callback: (event: NotifierEvent) => void,
          ) => {
            if (showThrows) {
              throw new Error("addon exploded");
            }
            calls.push({ request, emit: callback });
          },
        }
      : null,
}));

const { CATEGORY_ACTIONS, NOTIFICATION_CATEGORIES } =
  await import("@vellumai/electron-desktop/notifications");
const {
  createNativeNotificationFactory,
  registerNativeNotificationCategories,
} = await import("./native-notifications");

const avatarPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const sender = {
  id: "assistant-1",
  name: "Ada",
  avatarPng,
  avatarHash:
    "0f4636c78f65d3639ece5a064b5ae753e3408614a14fb18ab4d7540d2c248543",
};

// The addon only takes notifications that carry a sender, so every test that
// exercises it supplies one.
const options = (
  overrides: Partial<NotificationCreateOptions> = {},
): NotificationCreateOptions => ({
  title: "Weekly plan",
  body: "Your draft is ready",
  silent: false,
  actions: [
    { type: "button", text: "Allow" },
    { type: "button", text: "Deny" },
  ],
  sender,
  ...overrides,
});

afterAll(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  registered.length = 0;
  warnings.length = 0;
  electronNotifications.length = 0;
  delegateReassertions = 0;
  notifierSupported = true;
  notifierPresent = true;
  showThrows = false;
  rmSync(path.join(userDataDir, "notification-avatars"), {
    recursive: true,
    force: true,
  });
});

describe("registerNativeNotificationCategories", () => {
  test("registers every action set the shared categories declare, once, up front", () => {
    registerNativeNotificationCategories();

    expect(registered.length).toBe(1);
    const categories = registered[0]!;
    expect(categories.map((category) => category.actions)).toEqual(
      NOTIFICATION_CATEGORIES.map((category) =>
        CATEGORY_ACTIONS[category].map((action) => action.text),
      ),
    );
    for (const category of categories) {
      expect(category.categoryId).toMatch(/^vellum\.actions\.[0-9a-f]{16}$/);
    }
    expect(
      new Set(categories.map((category) => category.categoryId)).size,
    ).toBe(NOTIFICATION_CATEGORIES.length);
  });

  test("registers the id a notification with those actions will post under", () => {
    registerNativeNotificationCategories();
    createNativeNotificationFactory().create(options()).show();

    const registeredIds = registered[0]!.map((category) => category.categoryId);
    expect(registeredIds).toContain(calls[0]!.request.categoryId);
  });
});

describe("createNativeNotificationFactory", () => {
  test("exports isSupported alongside create", () => {
    const factory = createNativeNotificationFactory();
    expect(typeof factory.isSupported).toBe("function");
    expect(factory.isSupported()).toBe(true);

    notifierSupported = false;
    expect(factory.isSupported()).toBe(false);

    notifierPresent = false;
    expect(factory.isSupported()).toBe(false);
  });

  test("hands a notification without a sender to Electron's presenter", () => {
    createNativeNotificationFactory()
      .create(options({ sender: undefined }))
      .show();

    expect(calls.length).toBe(0);
    expect(electronNotifications).toEqual([
      {
        title: "Weekly plan",
        body: "Your draft is ready",
        silent: false,
        actions: [
          { type: "button", text: "Allow" },
          { type: "button", text: "Deny" },
        ],
      },
    ]);
  });

  // Electron's presenter claims the notification center's delegate and drops
  // responses for identifiers it does not own, so a post through it that left
  // the seat there would strand clicks on notifications the addon posted.
  test("puts the addon's delegate back in front after Electron posts", () => {
    const notification = createNativeNotificationFactory().create(
      options({ sender: undefined }),
    );
    expect(delegateReassertions).toBe(0);

    notification.show();

    expect(electronNotifications.length).toBe(1);
    expect(delegateReassertions).toBe(1);
  });

  test("leaves the delegate alone for a notification the addon posts", () => {
    createNativeNotificationFactory().create(options()).show();

    expect(delegateReassertions).toBe(0);
  });

  test("keeps a sender-less notification off the addon even when the addon is gone", () => {
    notifierPresent = false;
    const errors: string[] = [];
    const notification = createNativeNotificationFactory().create(
      options({ sender: undefined }),
    );
    notification.on("failed", (_event, error) => errors.push(error));
    notification.show();

    expect(errors).toEqual([]);
    expect(electronNotifications.length).toBe(1);
  });

  test("gives every distinct action set its own category id", () => {
    const factory = createNativeNotificationFactory();
    factory.create(options()).show();
    factory
      .create(options({ actions: [{ type: "button", text: "View" }] }))
      .show();
    factory.create(options()).show();
    factory.create(options({ actions: [] })).show();

    const [twoButton, oneButton, twoButtonAgain, noButton] = calls.map(
      (call) => call.request.categoryId,
    );
    expect(twoButton).not.toBe(oneButton);
    expect(twoButton).toBe(twoButtonAgain);
    expect(noButton).not.toBe(twoButton);
    expect(noButton).not.toBe(oneButton);
  });

  test("posts a notification with no actions", () => {
    createNativeNotificationFactory()
      .create(options({ actions: [] }))
      .show();

    expect(calls.length).toBe(1);
    const { request } = calls[0]!;
    expect(request.actions).toEqual([]);
    expect(request.categoryId).toMatch(/^vellum\.actions\.[0-9a-f]{16}$/);
  });

  test("swaps the sender name into the title and the title into the subtitle", () => {
    createNativeNotificationFactory().create(options()).show();

    const { request } = calls[0]!;
    expect(request.title).toBe("Ada");
    expect(request.subtitle).toBe("Weekly plan");
    expect(request.body).toBe("Your draft is ready");
    expect(request.sender?.id).toBe("assistant-1");
    expect(request.sender?.name).toBe("Ada");
    expect(request.sender?.conversationId).toBe("assistant-1");
    expect(request.id.length).toBeGreaterThan(0);
  });

  test("stages the avatar through the shared cache", () => {
    createNativeNotificationFactory().create(options()).show();

    const avatarPath = calls[0]!.request.sender!.avatarPngPath;
    expect(avatarPath).toBe(
      path.join(
        userDataDir,
        "notification-avatars",
        `${sender.avatarHash}.png`,
      ),
    );
    expect(readFileSync(avatarPath)).toEqual(avatarPng);
  });

  test("falls back to the plain layout when the avatar cannot be staged", () => {
    createNativeNotificationFactory()
      .create(options({ sender: { ...sender, avatarHash: "../../escape" } }))
      .show();

    const { request } = calls[0]!;
    expect(request.sender).toBeUndefined();
    expect(request.title).toBe("Weekly plan");
    expect(request.subtitle).toBeUndefined();
    expect(warnings.length).toBe(1);
  });

  test("maps addon events onto the notification listeners", () => {
    const events: string[] = [];
    const notification = createNativeNotificationFactory().create(options());
    notification.on("show", () => events.push("show"));
    notification.on("click", () => events.push("click"));
    notification.on("action", (_event, index) =>
      events.push(`action:${index}`),
    );
    notification.on("failed", (_event, error) =>
      events.push(`failed:${error}`),
    );
    notification.show();

    const { emit } = calls[0]!;
    emit({ kind: "shown" });
    emit({ kind: "click" });
    emit({ kind: "action", actionIndex: 1 });
    emit({ kind: "action" });
    // The addon emits `dismiss` to release its own callback; nothing
    // downstream acts on one.
    emit({ kind: "dismiss" });
    emit({ kind: "failed", error: "denied" });

    expect(events).toEqual(["show", "click", "action:1", "failed:denied"]);
  });

  test("shows a degraded notification and logs why", () => {
    const events: string[] = [];
    const notification = createNativeNotificationFactory().create(options());
    notification.on("show", () => events.push("show"));
    notification.show();

    calls[0]!.emit({
      kind: "shown",
      degraded: "the avatar file could not be read",
    });

    expect(events).toEqual(["show"]);
    expect(String(warnings[0]?.[1])).toBe("the avatar file could not be read");
  });

  test("acks a failure when the addon is gone", () => {
    notifierPresent = false;
    const errors: string[] = [];
    const notification = createNativeNotificationFactory().create(options());
    notification.on("failed", (_event, error) => errors.push(error));
    notification.show();

    expect(errors).toEqual(["Native notifier unavailable"]);
  });

  test("acks a failure when the addon throws", () => {
    showThrows = true;
    const errors: string[] = [];
    const notification = createNativeNotificationFactory().create(options());
    notification.on("failed", (_event, error) => errors.push(error));
    notification.show();

    expect(errors).toEqual(["addon exploded"]);
  });
});
