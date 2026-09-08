import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { NotificationCreateOptions } from "@vellumai/electron-desktop/notifications";

import type { NotifierEvent, NotifierRequest } from "./notifier";

const userDataDir = mkdtempSync(path.join(tmpdir(), "vellum-notif-avatars-"));

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

mock.module("./logger", () => ({
  default: { info: () => undefined, warn: () => undefined },
}));

interface Call {
  request: NotifierRequest;
  emit: (event: NotifierEvent) => void;
}

const calls: Call[] = [];
let notifierSupported = true;
let notifierPresent = true;
let showThrows = false;

mock.module("./notifier", () => ({
  getNotifier: () =>
    notifierPresent
      ? {
          isSupported: () => notifierSupported,
          requestAuthorization: () => undefined,
          reassertDelegate: () => undefined,
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

const { createNativeNotificationFactory } =
  await import("./native-notifications");

const avatarPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

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
  ...overrides,
});

const sender = {
  id: "assistant-1",
  name: "Ada",
  avatarPng,
  avatarHash: "abc123",
};

afterAll(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  notifierSupported = true;
  notifierPresent = true;
  showThrows = false;
  rmSync(path.join(userDataDir, "notification-avatars"), {
    recursive: true,
    force: true,
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

  test("posts a plain request without a sender", () => {
    createNativeNotificationFactory().create(options()).show();

    expect(calls.length).toBe(1);
    const { request } = calls[0]!;
    expect(request.title).toBe("Weekly plan");
    expect(request.subtitle).toBeUndefined();
    expect(request.body).toBe("Your draft is ready");
    expect(request.categoryId).toMatch(/^vellum\.actions\.[0-9a-f]{16}$/);
    expect(request.actions).toEqual(["Allow", "Deny"]);
    expect(request.sender).toBeUndefined();
    expect(request.id.length).toBeGreaterThan(0);
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
    createNativeNotificationFactory().create(options({ sender })).show();

    const { request } = calls[0]!;
    expect(request.title).toBe("Ada");
    expect(request.subtitle).toBe("Weekly plan");
    expect(request.sender?.id).toBe("assistant-1");
    expect(request.sender?.name).toBe("Ada");
    expect(request.sender?.conversationId).toBe("assistant-1");
  });

  test("writes the avatar under the user data directory keyed by its hash", () => {
    createNativeNotificationFactory().create(options({ sender })).show();

    const avatarPath = calls[0]!.request.sender!.avatarPngPath;
    expect(avatarPath).toBe(
      path.join(userDataDir, "notification-avatars", "abc123.png"),
    );
    expect(readFileSync(avatarPath)).toEqual(avatarPng);
  });

  test("prunes the avatar cache to the eight newest files", () => {
    const factory = createNativeNotificationFactory();
    for (let index = 0; index < 12; index++) {
      factory
        .create(options({ sender: { ...sender, avatarHash: `hash${index}` } }))
        .show();
    }

    const dir = path.join(userDataDir, "notification-avatars");
    expect(readdirSync(dir).length).toBe(8);
    expect(existsSync(path.join(dir, "hash11.png"))).toBe(true);
  });

  test("rejects a hash that would escape the avatar directory", () => {
    createNativeNotificationFactory()
      .create(options({ sender: { ...sender, avatarHash: "../../escape" } }))
      .show();

    const { request } = calls[0]!;
    expect(request.sender!.avatarPngPath).toBe(
      path.join(userDataDir, "notification-avatars", "______escape.png"),
    );
  });

  test("falls back to the plain layout when the avatar cannot be staged", () => {
    createNativeNotificationFactory()
      .create(options({ sender: { ...sender, avatarHash: "" } }))
      .show();

    const { request } = calls[0]!;
    expect(request.sender).toBeUndefined();
    expect(request.title).toBe("Weekly plan");
    expect(request.subtitle).toBeUndefined();
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
    emit({ kind: "dismiss" });
    emit({ kind: "failed", error: "denied" });

    expect(events).toEqual(["show", "click", "action:1", "failed:denied"]);
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
