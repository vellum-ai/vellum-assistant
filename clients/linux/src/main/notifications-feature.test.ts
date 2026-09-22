/**
 * The Linux helper toast factory, whose whole job beyond delivery is the
 * sender: when the renderer sends an assistant's avatar, the toast is from
 * that assistant, so its name is the title, the conversation title drops to
 * the subtitle, and the picture travels as a file path the helper reads.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
  app: {
    getAppPath: () => "/app",
    getPath: () => "/userData",
    once: () => undefined,
  },
  // The shared notifications module reaches these at import time; only the
  // helper factory is under test here.
  BrowserWindow: { getAllWindows: () => [] },
  nativeImage: { createFromBuffer: () => ({}) },
  Notification: class {
    static isSupported = () => true;
    on(): void {}
    show(): void {}
  },
}));

interface HelperCall {
  method: string;
  params: Record<string, unknown>;
}
const calls: HelperCall[] = [];
mock.module("@vellumai/native-sidecar/supervisor", () => ({
  NativeSidecarClient: class {
    onNotification(): void {}
    call(method: string, params: Record<string, unknown>): Promise<unknown> {
      calls.push({ method, params });
      return Promise.resolve({ success: true });
    }
    shutdown(): void {}
  },
}));

let avatarFileError: Error | null = null;
const ensureNotificationAvatarFile = mock(() => {
  if (avatarFileError) {
    throw avatarFileError;
  }
  return "/userData/notification-avatars/abc.png";
});
mock.module("@vellumai/electron-desktop/notification-avatar-file", () => ({
  ensureNotificationAvatarFile,
}));

mock.module("./ipc.client", () => ({ handle: () => undefined }));
mock.module("./main-window", () => ({ ensureVisible: () => undefined }));
const warn = mock(() => undefined);
mock.module("./logger", () => ({ default: { warn, info: () => undefined } }));

const { createHelperToastFactory } = await import("./features/notifications");

const AVATAR_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const AVATAR_HASH = "a".repeat(64);

const sender = {
  id: "assistant-1",
  name: "Aria",
  avatarPng: AVATAR_PNG,
  avatarHash: AVATAR_HASH,
};

const baseOptions = {
  title: "Weekly review",
  body: "Three items need you",
  silent: false,
  actions: [{ type: "button" as const, text: "View" }],
};

const showToast = async (
  options: Parameters<ReturnType<typeof createHelperToastFactory>>[0],
): Promise<void> => {
  const toast = createHelperToastFactory("/helper")(options);
  toast.show();
  // `show()` defers the call so a synchronous throw still acks as a failed
  // delivery, so the params land a couple of microtasks later.
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  calls.length = 0;
  avatarFileError = null;
  ensureNotificationAvatarFile.mockClear();
  warn.mockClear();
});

describe("Linux helper toast factory", () => {
  test("posts a sender's toast under the assistant's name with the avatar file", async () => {
    await showToast({ ...baseOptions, sender });

    expect(ensureNotificationAvatarFile).toHaveBeenCalledWith(
      "/userData",
      AVATAR_PNG,
      AVATAR_HASH,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("notifications/show");
    expect(calls[0]!.params).toMatchObject({
      title: "Aria",
      subtitle: "Weekly review",
      body: "Three items need you",
      avatarPath: "/userData/notification-avatars/abc.png",
      actions: [{ text: "View" }],
    });
  });

  test("keeps the conversation title and sends no avatar without a sender", async () => {
    await showToast(baseOptions);

    expect(ensureNotificationAvatarFile).not.toHaveBeenCalled();
    expect(calls[0]!.params).toMatchObject({
      title: "Weekly review",
      body: "Three items need you",
    });
    expect(calls[0]!.params).not.toHaveProperty("subtitle");
    expect(calls[0]!.params).not.toHaveProperty("avatarPath");
  });

  test("falls back to the plain toast when the avatar file cannot be written", async () => {
    avatarFileError = new Error("read-only volume");

    await showToast({ ...baseOptions, sender });

    expect(warn).toHaveBeenCalled();
    expect(calls[0]!.params).toMatchObject({ title: "Weekly review" });
    expect(calls[0]!.params).not.toHaveProperty("avatarPath");
  });
});
