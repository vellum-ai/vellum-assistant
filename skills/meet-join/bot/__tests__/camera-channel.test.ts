/**
 * Unit tests for `src/native-messaging/camera-channel.ts`.
 *
 * Drives the channel with a fake socket-server plumbing so the request/
 * response correlation, timeout, and shutdown paths can be exercised
 * without standing up a real Unix socket.
 */

import { afterEach, describe, expect, test } from "bun:test";

import type {
  BotToExtensionMessage,
  ExtensionToBotMessage,
} from "../../contracts/native-messaging.js";
import {
  createCameraChannel,
  DEFAULT_CAMERA_CHANNEL_TIMEOUT_MS,
} from "../src/native-messaging/camera-channel.js";

interface FakeSocket {
  sent: BotToExtensionMessage[];
  listeners: Array<(msg: ExtensionToBotMessage) => void>;
  sendToExtension: (msg: BotToExtensionMessage) => void;
  onExtensionMessage: (cb: (msg: ExtensionToBotMessage) => void) => void;
  /** Simulate an inbound frame from the extension. */
  emit: (msg: ExtensionToBotMessage) => void;
}

function makeFakeSocket(): FakeSocket {
  const sent: BotToExtensionMessage[] = [];
  const listeners: Array<(msg: ExtensionToBotMessage) => void> = [];
  return {
    sent,
    listeners,
    sendToExtension: (msg) => {
      sent.push(msg);
    },
    onExtensionMessage: (cb) => {
      listeners.push(cb);
    },
    emit: (msg) => {
      for (const cb of listeners) cb(msg);
    },
  };
}

describe("createCameraChannel", () => {
  test("enableCamera dispatches camera.enable with a requestId and awaits camera_result", async () => {
    const socket = makeFakeSocket();
    let counter = 0;
    const channel = createCameraChannel({
      sendToExtension: socket.sendToExtension,
      onExtensionMessage: socket.onExtensionMessage,
      generateRequestId: () => `req-${++counter}`,
    });

    const p = channel.enableCamera();

    // One frame dispatched: camera.enable with req-1.
    expect(socket.sent).toHaveLength(1);
    const sent = socket.sent[0]!;
    expect(sent.type).toBe("camera.enable");
    if (sent.type === "camera.enable") {
      expect(sent.requestId).toBe("req-1");
    }

    // Extension replies ok=true changed=true.
    socket.emit({
      type: "camera_result",
      requestId: "req-1",
      ok: true,
      changed: true,
    });

    const result = await p;
    expect(result).toEqual({ changed: true });
  });

  test("disableCamera dispatches camera.disable with a fresh requestId", async () => {
    const socket = makeFakeSocket();
    let counter = 0;
    const channel = createCameraChannel({
      sendToExtension: socket.sendToExtension,
      onExtensionMessage: socket.onExtensionMessage,
      generateRequestId: () => `req-${++counter}`,
    });

    const p = channel.disableCamera();
    const sent = socket.sent[0]!;
    expect(sent.type).toBe("camera.disable");
    if (sent.type === "camera.disable") {
      expect(sent.requestId).toBe("req-1");
    }

    socket.emit({
      type: "camera_result",
      requestId: "req-1",
      ok: true,
      changed: false,
    });

    const result = await p;
    expect(result).toEqual({ changed: false });
  });

  test("rejects with the extension-provided error on ok=false", async () => {
    const socket = makeFakeSocket();
    let counter = 0;
    const channel = createCameraChannel({
      sendToExtension: socket.sendToExtension,
      onExtensionMessage: socket.onExtensionMessage,
      generateRequestId: () => `req-${++counter}`,
    });

    const p = channel.enableCamera();
    socket.emit({
      type: "camera_result",
      requestId: "req-1",
      ok: false,
      error: "toggle button not found",
    });

    await expect(p).rejects.toThrow(/toggle button not found/);
  });

  test("rejects with a timeout error when the extension never replies", async () => {
    const socket = makeFakeSocket();
    const channel = createCameraChannel({
      sendToExtension: socket.sendToExtension,
      onExtensionMessage: socket.onExtensionMessage,
      generateRequestId: () => "req-timeout",
      timeoutMs: 50,
    });

    await expect(channel.enableCamera()).rejects.toThrow(
      /did not reply within/,
    );
  });

  test("ignores a camera_result for an unknown requestId (late reply after timeout)", async () => {
    const socket = makeFakeSocket();
    const channel = createCameraChannel({
      sendToExtension: socket.sendToExtension,
      onExtensionMessage: socket.onExtensionMessage,
      generateRequestId: () => "req-late",
      timeoutMs: 30,
    });

    // First await the timeout, then fire a late reply — this must not
    // throw, crash, or leak state.
    await expect(channel.enableCamera()).rejects.toThrow();
    expect(() => {
      socket.emit({
        type: "camera_result",
        requestId: "req-late",
        ok: true,
        changed: true,
      });
    }).not.toThrow();
  });

  test("ignores non-camera_result frames (fan-out alongside other listeners)", async () => {
    const socket = makeFakeSocket();
    let counter = 0;
    const channel = createCameraChannel({
      sendToExtension: socket.sendToExtension,
      onExtensionMessage: socket.onExtensionMessage,
      generateRequestId: () => `req-${++counter}`,
    });

    const p = channel.enableCamera();

    // Unrelated diagnostic must not complete the pending camera request.
    socket.emit({ type: "diagnostic", level: "info", message: "hello" });

    // Now the real reply — this should resolve the promise.
    socket.emit({
      type: "camera_result",
      requestId: "req-1",
      ok: true,
      changed: true,
    });

    await expect(p).resolves.toEqual({ changed: true });
  });

  test("shutdown rejects in-flight requests with the provided reason", async () => {
    const socket = makeFakeSocket();
    const channel = createCameraChannel({
      sendToExtension: socket.sendToExtension,
      onExtensionMessage: socket.onExtensionMessage,
      generateRequestId: () => "req-1",
      timeoutMs: 10_000,
    });

    const p = channel.enableCamera();
    channel.shutdown("bot stopping");

    await expect(p).rejects.toThrow(/bot stopping/);
  });

  test("rejects synchronously when sendToExtension throws", async () => {
    const throwingSocket: FakeSocket = {
      ...makeFakeSocket(),
      sendToExtension: () => {
        throw new Error("socket not connected");
      },
    };
    const channel = createCameraChannel({
      sendToExtension: throwingSocket.sendToExtension,
      onExtensionMessage: throwingSocket.onExtensionMessage,
      generateRequestId: () => "req-1",
    });

    await expect(channel.enableCamera()).rejects.toThrow(
      /socket not connected/,
    );
  });

  test("DEFAULT_CAMERA_CHANNEL_TIMEOUT_MS is generous enough for the 5s extension poll", () => {
    // Sanity: default timeout must exceed the extension's aria-state poll
    // window so a slow-but-successful transition doesn't trip the bot-side
    // timer before the extension has a chance to reply.
    expect(DEFAULT_CAMERA_CHANNEL_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});

describe("createCameraChannel (integration with the http-server shape)", () => {
  // Smoke: camera channel exposes the exact interface the http-server's
  // `HttpServerAvatarOptions.camera` callsite requires.
  test("exposes enableCamera + disableCamera matching the http-server contract", () => {
    const socket = makeFakeSocket();
    const channel = createCameraChannel({
      sendToExtension: socket.sendToExtension,
      onExtensionMessage: socket.onExtensionMessage,
    });
    expect(typeof channel.enableCamera).toBe("function");
    expect(typeof channel.disableCamera).toBe("function");
    expect(typeof channel.shutdown).toBe("function");
  });
});

afterEach(() => {
  // No global state to clean up — each test creates its own fake socket.
});
