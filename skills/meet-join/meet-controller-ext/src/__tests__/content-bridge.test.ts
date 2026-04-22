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
  tabResponses: Map<number, (msg: unknown) => unknown>;
  runtime: {
    onMessage: {
      addListener: (cb: RuntimeOnMessageListener) => void;
    };
  };
  tabs: {
    query: (q: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>;
    sendMessage: (tabId: number, msg: unknown) => Promise<unknown>;
  };
}

function installFakeChrome(): FakeChrome {
  const sendMessageCalls: FakeChrome["sendMessageCalls"] = [];
  const queryCalls: FakeChrome["queryCalls"] = [];
  const runtimeListeners: RuntimeOnMessageListener[] = [];
  const tabResponses = new Map<number, (msg: unknown) => unknown>();
  const fake: FakeChrome = {
    sendMessageCalls,
    queryCalls,
    runtimeListeners,
    tabResponses,
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
        const responder = tabResponses.get(tabId);
        if (responder) return responder(msg);
        return undefined;
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

  test(
    "pending join retry aborts when a later leave supersedes it",
    async () => {
      // A join fan-out is stuck retrying because no tab exists yet. Before
      // the first retry fires, a leave arrives — the later message must
      // cancel the stale join so we don't join a session the bot has
      // already decided to leave.
      //
      // The join finds no tab (so it queues a retry). The leave finds a
      // tab and delivers on its first attempt — that way only the join's
      // retry behavior is under test and leave's own retry cadence can't
      // leak into the assertion. We assert the invariant directly: the
      // stale `join` frame must never reach `chrome.tabs.sendMessage`.
      let tabsAvailable: chrome.tabs.Tab[] = [];
      fake.tabs.query = async (q) => {
        fake.queryCalls.push(q);
        return tabsAvailable;
      };
      const join: BotToExtensionMessage = {
        type: "join",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Bot",
        consentMessage: "hello",
      };
      const leave: BotToExtensionMessage = { type: "leave", reason: "cancel" };
      port.emitFromBot(join);
      await flushMicrotasks();
      // Join queried once, no tabs — it's now sleeping 100ms before retry.
      expect(fake.queryCalls.length).toBe(1);
      // Now a tab exists and the leave supersedes the pending join.
      tabsAvailable = [{ id: 1 } as chrome.tabs.Tab];
      port.emitFromBot(leave);
      // Wait past the join's first retry delay (100ms) plus margin.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const byType = (t: string) =>
        fake.sendMessageCalls.filter(
          (c) => (c.msg as { type: string }).type === t,
        );
      // The stale join must not have been delivered.
      expect(byType("join")).toHaveLength(0);
      // Leave was delivered (this is the positive invariant — without it
      // the test would pass if the bridge silently dropped everything).
      expect(byType("leave").length).toBeGreaterThanOrEqual(1);
    },
    5_000,
  );

  test(
    "two send_chat messages both deliver — neither supersedes the other",
    async () => {
      // send_chat is outside any superseding category, so a rapidly-issued
      // pair must both reach the content script. Guard: before PR 27314's
      // follow-up, the generation counter was bumped for every message,
      // which silently aborted the first send_chat while it was sleeping
      // between retries.
      let tabsAvailable: chrome.tabs.Tab[] = [];
      fake.tabs.query = async (q) => {
        fake.queryCalls.push(q);
        return tabsAvailable;
      };
      const first: BotToExtensionMessage = {
        type: "send_chat",
        text: "hello",
        requestId: "req-1",
      };
      const second: BotToExtensionMessage = {
        type: "send_chat",
        text: "world",
        requestId: "req-2",
      };
      // First send_chat: no tab yet, queues a retry.
      port.emitFromBot(first);
      await flushMicrotasks();
      expect(fake.queryCalls.length).toBe(1);
      // Second send_chat arrives before the first retry fires. A tab is
      // now mounted so both should be able to deliver.
      tabsAvailable = [{ id: 1 } as chrome.tabs.Tab];
      port.emitFromBot(second);
      // Wait past the first's retry delay (100ms) plus margin.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const chatDeliveries = fake.sendMessageCalls.filter(
        (c) => (c.msg as { type: string }).type === "send_chat",
      );
      expect(chatDeliveries).toHaveLength(2);
      const deliveredIds = chatDeliveries.map(
        (c) => (c.msg as { requestId: string }).requestId,
      );
      expect(deliveredIds).toContain("req-1");
      expect(deliveredIds).toContain("req-2");
    },
    5_000,
  );

  test(
    "join retries when the only tab responds with {ok:false}",
    async () => {
      // Simulate a profile that has exactly one Meet tab open and that tab is
      // not for the target meeting (e.g. a stray lobby tab). The content
      // script rejects the join with {ok:false}. The bridge must NOT treat
      // that as a successful delivery — otherwise a real tab that mounts a
      // moment later never receives the join command.
      fake.tabs.sendMessage = async (tabId, msg) => {
        fake.sendMessageCalls.push({ tabId, msg });
        return { ok: false, reason: "non-matching-tab" };
      };
      const join: BotToExtensionMessage = {
        type: "join",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Bot",
        consentMessage: "hello",
      };
      port.emitFromBot(join);
      // Wait long enough for at least the first retry (100ms) to elapse.
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(fake.queryCalls.length).toBeGreaterThanOrEqual(2);
      expect(fake.sendMessageCalls.length).toBeGreaterThanOrEqual(2);
    },
    5_000,
  );
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
