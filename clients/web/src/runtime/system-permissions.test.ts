import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  requestSystemPermission,
  supportsSystemPermissions,
} from "@/runtime/system-permissions";

const permissionItem = {
  kind: "notifications" as const,
  status: "granted" as const,
  canRequest: false,
  canOpenSettings: false,
  requiresRestart: false,
};

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
    avatarHash: "b".repeat(64),
  },
};

const installBridge = (
  hostOS: "macos" | "windows",
  request: (...args: unknown[]) => Promise<unknown>,
): void => {
  window.vellum = {
    platform: "electron",
    hostOS,
    permissions: {
      getState: async () => ({}),
      request,
    },
  } as unknown as Window["vellum"];
};

afterEach(() => {
  delete window.vellum;
});

describe("requestSystemPermission", () => {
  test("returns null without the desktop permissions capability", async () => {
    expect(supportsSystemPermissions()).toBe(false);
    expect(
      await requestSystemPermission("notifications", presentation),
    ).toBeNull();
  });

  test("threads an optional notification presentation to macOS", async () => {
    const request = mock(async () => permissionItem);
    installBridge("macos", request);

    expect(
      await requestSystemPermission("notifications", presentation),
    ).toEqual(permissionItem);
    expect(request).toHaveBeenCalledWith("notifications", presentation);
  });

  test("keeps Windows requests plain", async () => {
    const request = mock(async () => permissionItem);
    installBridge("windows", request);

    await requestSystemPermission("notifications", presentation);

    expect(request).toHaveBeenCalledWith("notifications");
    expect(request.mock.calls[0]).toHaveLength(1);
  });

  test("keeps callers without presentation unchanged", async () => {
    const request = mock(async () => ({ ...permissionItem, kind: "microphone" }));
    installBridge("macos", request);

    await requestSystemPermission("microphone");

    expect(request).toHaveBeenCalledWith("microphone");
    expect(request.mock.calls[0]).toHaveLength(1);
  });

  test("remains compatible with a preload that accepts only the kind", async () => {
    const received: unknown[] = [];
    const oldRequest = async (kind: unknown) => {
      received.push(kind);
      return permissionItem;
    };
    installBridge("macos", oldRequest);

    expect(
      await requestSystemPermission("notifications", presentation),
    ).toEqual(permissionItem);
    expect(received).toEqual(["notifications"]);
  });
});
