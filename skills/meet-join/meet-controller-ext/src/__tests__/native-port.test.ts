/**
 * Unit tests for the native-messaging port wrapper.
 *
 * These tests stub the portions of the `chrome.runtime` API the wrapper
 * touches (`connectNative` + `Port.onMessage` / `onDisconnect` / `postMessage`
 * / `disconnect`) so we can assert the protocol validation and
 * auto-reconnect semantics without a real browser.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_RECONNECT_BASE_MS,
  NATIVE_HOST_NAME,
  openNativePort,
} from "../messaging/native-port.js";

/** Recorded call to {@link chrome.runtime.connectNative}. */
interface ConnectCall {
  app: string;
  port: FakePort;
}

/** Minimal in-memory stand-in for {@link chrome.runtime.Port}. */
interface FakePort {
  name: string;
  postMessage(msg: unknown): void;
  disconnect(): void;
  messageListeners: Array<(msg: unknown, port: FakePort) => void>;
  disconnectListeners: Array<(port: FakePort) => void>;
  sent: unknown[];
  disconnected: boolean;
  onMessage: {
    addListener(cb: (msg: unknown, port: FakePort) => void): void;
  };
  onDisconnect: {
    addListener(cb: (port: FakePort) => void): void;
  };
}

interface FakeChrome {
  connectCalls: ConnectCall[];
  runtime: {
    connectNative: (app: string) => FakePort;
    lastError?: { message: string } | undefined;
  };
}

function installFakeChrome(): FakeChrome {
  const connectCalls: ConnectCall[] = [];
  const fake: FakeChrome = {
    connectCalls,
    runtime: {
      connectNative(app: string): FakePort {
        const port: FakePort = {
          name: app,
          messageListeners: [],
          disconnectListeners: [],
          sent: [],
          disconnected: false,
          postMessage(msg: unknown) {
            if (this.disconnected) {
              throw new Error("port is disconnected");
            }
            this.sent.push(msg);
          },
          disconnect() {
            this.disconnected = true;
          },
          onMessage: {
            addListener: (cb) => {
              port.messageListeners.push(cb);
            },
          },
          onDisconnect: {
            addListener: (cb) => {
              port.disconnectListeners.push(cb);
            },
          },
        };
        connectCalls.push({ app, port });
        return port;
      },
      lastError: undefined,
    },
  };
  // Cast through unknown because the real @types/chrome Port is richer than
  // our fake; we only implement the surface `openNativePort` uses.
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return fake;
}

function uninstallFakeChrome(): void {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

function emit(port: FakePort, msg: unknown): void {
  for (const cb of port.messageListeners) cb(msg, port);
}

function disconnect(port: FakePort): void {
  port.disconnected = true;
  for (const cb of port.disconnectListeners) cb(port);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("openNativePort", () => {
  let fake: FakeChrome;

  beforeEach(() => {
    fake = installFakeChrome();
  });

  afterEach(() => {
    uninstallFakeChrome();
  });

  test("calls connectNative with the Vellum host name", () => {
    const handle = openNativePort({});
    expect(fake.connectCalls.length).toBe(1);
    expect(fake.connectCalls[0]!.app).toBe(NATIVE_HOST_NAME);
    expect(NATIVE_HOST_NAME).toBe("com.vellum.meet");
    handle.close();
  });

  test("parses valid inbound messages and invokes onMessage", () => {
    const handle = openNativePort({});
    const received: unknown[] = [];
    handle.onMessage((msg) => received.push(msg));

    const port = fake.connectCalls[0]!.port;
    const joinCommand = {
      type: "join",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      displayName: "Vellum Bot",
      consentMessage: "Hi, I'm here to take notes.",
    };
    emit(port, joinCommand);

    expect(received.length).toBe(1);
    expect(received[0]).toEqual(joinCommand);
    handle.close();
  });

  test("rejects invalid inbound shape, reports via onDisconnect, and reconnects", async () => {
    const baseMs = 25;
    const handle = openNativePort({
      reconnectBaseMs: baseMs,
      reconnectMaxMs: 1_000,
    });
    const disconnects: string[] = [];
    handle.onDisconnect((reason) => disconnects.push(reason));

    const port = fake.connectCalls[0]!.port;
    // Missing `type` discriminator is a protocol error.
    emit(port, { meetingUrl: "https://meet.google.com/abc" });

    expect(disconnects.length).toBe(1);
    expect(disconnects[0]).toContain("protocol error");
    // The wrapper should have torn down the port so callers can't double-send.
    expect(port.disconnected).toBe(true);
    // Initial connect + no reconnect yet (backoff pending).
    expect(fake.connectCalls.length).toBe(1);

    // Wait past the backoff to observe the reconnect.
    await sleep(baseMs + 20);
    expect(fake.connectCalls.length).toBe(2);
    handle.close();
  });

  test("post() throws synchronously on invalid outbound messages", () => {
    const handle = openNativePort({});
    // `ready` requires `extensionVersion` per ExtensionReadyMessageSchema.
    expect(() => {
      // Cast through unknown to let us hand in an invalid shape.
      handle.post({ type: "ready" } as unknown as Parameters<
        typeof handle.post
      >[0]);
    }).toThrow();
    // No frame should have been forwarded to the underlying port.
    expect(fake.connectCalls[0]!.port.sent.length).toBe(0);
    handle.close();
  });

  test("post() forwards valid outbound messages verbatim", () => {
    const handle = openNativePort({});
    const msg = {
      type: "ready" as const,
      extensionVersion: "0.0.1",
    };
    handle.post(msg);
    const port = fake.connectCalls[0]!.port;
    expect(port.sent.length).toBe(1);
    expect(port.sent[0]).toEqual(msg);
    handle.close();
  });

  test("reconnects with exponential backoff capped at reconnectMaxMs", async () => {
    const baseMs = 20;
    const maxMs = 40;
    const handle = openNativePort({
      reconnectBaseMs: baseMs,
      reconnectMaxMs: maxMs,
    });

    // Trigger first disconnect; reconnect fires after `baseMs`.
    disconnect(fake.connectCalls[0]!.port);
    await sleep(baseMs + 20);
    expect(fake.connectCalls.length).toBe(2);

    // Second disconnect; backoff is `baseMs * 2` but capped at `maxMs`.
    disconnect(fake.connectCalls[1]!.port);
    await sleep(maxMs + 20);
    expect(fake.connectCalls.length).toBe(3);

    handle.close();
  });

  test("close() prevents further reconnect attempts", async () => {
    const baseMs = 20;
    const handle = openNativePort({ reconnectBaseMs: baseMs });
    const port = fake.connectCalls[0]!.port;
    handle.close();
    // Even after a disconnect fires, close() should have torn everything down.
    disconnect(port);
    await sleep(baseMs + 20);
    expect(fake.connectCalls.length).toBe(1);
  });
});

test("DEFAULT_RECONNECT_BASE_MS is 500ms", () => {
  expect(DEFAULT_RECONNECT_BASE_MS).toBe(500);
});
