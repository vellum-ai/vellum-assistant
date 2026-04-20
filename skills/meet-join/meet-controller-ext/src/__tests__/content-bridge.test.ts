/**
 * Unit tests for the content-bridge router in `messaging/content-bridge.ts`.
 *
 * The bridge fans out bot→extension commands to every open Meet tab via
 * `chrome.tabs.sendMessage`. `avatar.*` frames are delivered to the separate
 * avatar tab by the background's avatar feature (see `features/avatar.ts`),
 * not the Meet content script — so the bridge must skip them to avoid
 * ~20 pointless `chrome.tabs.sendMessage` calls/sec per Meet tab at TTS
 * viseme cadence.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  BotToExtensionMessage,
  ExtensionToBotMessage,
} from "../../../contracts/native-messaging.js";

import { startContentBridge } from "../messaging/content-bridge.js";
import type { NativePort } from "../messaging/native-port.js";

interface FakePort extends NativePort {
  emitFromBot(msg: BotToExtensionMessage): void;
  posted: ExtensionToBotMessage[];
}

function makeFakePort(): FakePort {
  const messageCallbacks: Array<(msg: BotToExtensionMessage) => void> = [];
  const posted: ExtensionToBotMessage[] = [];
  return {
    posted,
    post(msg: ExtensionToBotMessage) {
      posted.push(msg);
    },
    onMessage(cb) {
      messageCallbacks.push(cb);
    },
    onConnect() {
      /* no-op */
    },
    onDisconnect() {
      /* no-op */
    },
    close() {
      /* no-op */
    },
    emitFromBot(msg) {
      for (const cb of messageCallbacks.slice()) cb(msg);
    },
  };
}

type RuntimeOnMessageListener = (
  raw: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean;

interface FakeChrome {
  sendMessageCalls: Array<{ tabId: number; msg: unknown }>;
  queryCalls: Array<chrome.tabs.QueryInfo>;
  runtimeListeners: RuntimeOnMessageListener[];
  emitFromContent(msg: unknown): void;
  runtime: {
    onMessage: {
      addListener: (cb: RuntimeOnMessageListener) => void;
    };
  };
  tabs: {
    query: (q: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>;
    sendMessage: (tabId: number, msg: unknown) => Promise<void>;
  };
}

function installFakeChrome(): FakeChrome {
  const sendMessageCalls: FakeChrome["sendMessageCalls"] = [];
  const queryCalls: FakeChrome["queryCalls"] = [];
  const runtimeListeners: RuntimeOnMessageListener[] = [];
  const fake: FakeChrome = {
    sendMessageCalls,
    queryCalls,
    runtimeListeners,
    emitFromContent(msg) {
      for (const cb of runtimeListeners.slice())
        cb(msg, undefined, () => {});
    },
    runtime: {
      onMessage: {
        addListener(cb) {
          runtimeListeners.push(cb);
        },
      },
    },
    tabs: {
      async query(q) {
        queryCalls.push(q);
        return [{ id: 1 } as chrome.tabs.Tab];
      },
      async sendMessage(tabId, msg) {
        sendMessageCalls.push({ tabId, msg });
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return fake;
}

function uninstallFakeChrome(): void {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

/** Let all queued microtasks / `await` continuations settle. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("startContentBridge bot→content fan-out", () => {
  let fake: FakeChrome;
  let port: FakePort;

  beforeEach(() => {
    fake = installFakeChrome();
    port = makeFakePort();
    startContentBridge(port);
  });

  afterEach(() => {
    uninstallFakeChrome();
  });

  test("avatar.push_viseme does not fire chrome.tabs.sendMessage", async () => {
    port.emitFromBot({
      type: "avatar.push_viseme",
      phoneme: "amp",
      weight: 0.5,
      timestamp: 123,
    });
    await flushMicrotasks();
    expect(fake.sendMessageCalls).toHaveLength(0);
    // We also short-circuit before issuing a tabs.query; a query would be
    // wasted work for a frame we know is not destined for a Meet tab.
    expect(fake.queryCalls).toHaveLength(0);
  });

  test("avatar.start and avatar.stop are skipped as well", async () => {
    port.emitFromBot({ type: "avatar.start" });
    port.emitFromBot({ type: "avatar.stop" });
    await flushMicrotasks();
    expect(fake.sendMessageCalls).toHaveLength(0);
    expect(fake.queryCalls).toHaveLength(0);
  });

  test("non-avatar frames (leave) still fan out to Meet tabs", async () => {
    const leave: BotToExtensionMessage = { type: "leave", reason: "wrap-up" };
    port.emitFromBot(leave);
    await flushMicrotasks();
    expect(fake.sendMessageCalls).toHaveLength(1);
    expect(fake.sendMessageCalls[0]).toEqual({
      tabId: 1,
      msg: leave,
    });
  });
});

describe("startContentBridge content→bot forwarding", () => {
  let fake: FakeChrome;
  let port: FakePort;

  beforeEach(() => {
    fake = installFakeChrome();
    port = makeFakePort();
    startContentBridge(port);
  });

  afterEach(() => {
    uninstallFakeChrome();
  });

  test("avatar.frame from runtime is NOT relayed to the native port", () => {
    // The avatar feature owns this forwarding path; relaying here would
    // double every frame.
    fake.emitFromContent({
      type: "avatar.frame",
      bytes: "AA==",
      width: 320,
      height: 240,
      format: "jpeg",
      ts: 0,
    });
    expect(port.posted).toHaveLength(0);
  });

  test("avatar.started from runtime is NOT relayed to the native port", () => {
    fake.emitFromContent({ type: "avatar.started" });
    expect(port.posted).toHaveLength(0);
  });

  test("non-avatar content→bot messages still forward to the native port", () => {
    const msg: ExtensionToBotMessage = {
      type: "chat.inbound",
      meetingId: "abc",
      timestamp: "2026-04-15T00:00:00Z",
      fromId: "p-1",
      fromName: "Alice",
      text: "hey",
    };
    fake.emitFromContent(msg);
    expect(port.posted).toContainEqual(msg);
  });
});
