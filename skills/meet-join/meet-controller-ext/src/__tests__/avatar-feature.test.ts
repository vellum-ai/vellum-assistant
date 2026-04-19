/**
 * Tests for the extension's avatar feature (background-wiring side).
 *
 * The feature opens the pinned second Chrome tab on `avatar.start`,
 * forwards `avatar.push_viseme` to the tab, relays `avatar.frame` /
 * `avatar.started` back to the bot, and tears the tab down on
 * `avatar.stop`. We fake `chrome.tabs` + `chrome.runtime` + the
 * native port so the feature can be exercised without a real Chrome
 * or native-messaging host.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  BotToExtensionMessage,
  ExtensionAvatarFrameMessage,
  ExtensionToBotMessage,
} from "../../../contracts/native-messaging.js";

import {
  startAvatarFeature,
  type AvatarRuntimeApi,
  type AvatarTabsApi,
} from "../features/avatar.js";

interface TabCreateCall {
  url: string;
  active?: boolean;
  pinned?: boolean;
}

interface FakeTabs extends AvatarTabsApi {
  createCalls: TabCreateCall[];
  removeCalls: number[];
  sendMessageCalls: Array<{ tabId: number; msg: unknown }>;
  nextCreateId: number;
  /** When set, `create()` rejects with this error. */
  createError?: Error;
  /** When set, `remove()` rejects with this error. */
  removeError?: Error;
}

function makeFakeTabs(): FakeTabs {
  const fake: FakeTabs = {
    createCalls: [],
    removeCalls: [],
    sendMessageCalls: [],
    nextCreateId: 1,
    async create(opts) {
      fake.createCalls.push(opts);
      if (fake.createError) throw fake.createError;
      const id = fake.nextCreateId++;
      return { id };
    },
    async remove(tabId) {
      fake.removeCalls.push(tabId);
      if (fake.removeError) throw fake.removeError;
    },
    async sendMessage(tabId, msg) {
      fake.sendMessageCalls.push({ tabId, msg });
    },
  };
  return fake;
}

interface FakeRuntime extends AvatarRuntimeApi {
  listeners: Array<
    (
      raw: unknown,
      sender: unknown,
      sendResponse: (response?: unknown) => void,
    ) => boolean
  >;
  /** Helper: deliver a message to every registered listener. */
  emitFromTab(msg: unknown): void;
}

function makeFakeRuntime(extensionId = "abcd1234"): FakeRuntime {
  const listeners: FakeRuntime["listeners"] = [];
  const fake: FakeRuntime = {
    listeners,
    onMessage: {
      addListener(cb) {
        listeners.push(cb);
      },
    },
    getURL(path) {
      return `chrome-extension://${extensionId}/${path}`;
    },
    emitFromTab(msg) {
      for (const cb of listeners.slice()) cb(msg, undefined, () => {});
    },
  };
  return fake;
}

interface FakePort {
  posted: ExtensionToBotMessage[];
  post(msg: ExtensionToBotMessage): void;
  /** When true, `post` throws. */
  failNextPost?: boolean;
}

function makeFakePort(): FakePort {
  const posted: ExtensionToBotMessage[] = [];
  const fake: FakePort = {
    posted,
    post(msg) {
      if (fake.failNextPost) {
        fake.failNextPost = false;
        throw new Error("native port disconnected");
      }
      posted.push(msg);
    },
  };
  return fake;
}

describe("startAvatarFeature", () => {
  let tabs: FakeTabs;
  let runtime: FakeRuntime;
  let port: FakePort;
  let feature: ReturnType<typeof startAvatarFeature>;

  beforeEach(() => {
    tabs = makeFakeTabs();
    runtime = makeFakeRuntime();
    port = makeFakePort();
    feature = startAvatarFeature({ tabs, runtime, port });
  });

  afterEach(async () => {
    await feature.stop();
  });

  test("opens the pinned avatar tab on avatar.start", async () => {
    await feature.handleBotCommand({ type: "avatar.start" });
    expect(tabs.createCalls).toHaveLength(1);
    const call = tabs.createCalls[0]!;
    expect(call.pinned).toBe(true);
    expect(call.active).toBe(false);
    expect(call.url).toBe("chrome-extension://abcd1234/avatar/avatar.html");
  });

  test("avatar.start forwards modelUrl as a query string", async () => {
    await feature.handleBotCommand({
      type: "avatar.start",
      modelUrl: "https://example.com/custom.glb",
    });
    expect(tabs.createCalls).toHaveLength(1);
    const url = new URL(tabs.createCalls[0]!.url);
    expect(url.searchParams.get("model")).toBe(
      "https://example.com/custom.glb",
    );
  });

  test("avatar.push_viseme is forwarded to the avatar tab", async () => {
    await feature.handleBotCommand({ type: "avatar.start" });
    await feature.handleBotCommand({
      type: "avatar.push_viseme",
      phoneme: "ah",
      weight: 0.7,
      timestamp: 500,
    });
    expect(tabs.sendMessageCalls).toHaveLength(1);
    const call = tabs.sendMessageCalls[0]!;
    expect(call.tabId).toBe(1);
    expect(call.msg).toEqual({
      type: "avatar.push_viseme",
      phoneme: "ah",
      weight: 0.7,
      timestamp: 500,
    });
  });

  test("avatar.push_viseme before the tab opens is dropped silently", async () => {
    // No avatar.start yet — tab id is null.
    await feature.handleBotCommand({
      type: "avatar.push_viseme",
      phoneme: "ah",
      weight: 0.5,
      timestamp: 0,
    });
    expect(tabs.sendMessageCalls).toHaveLength(0);
  });

  test("avatar.frame from the tab is forwarded to the native port", async () => {
    await feature.handleBotCommand({ type: "avatar.start" });

    const frame: ExtensionAvatarFrameMessage = {
      type: "avatar.frame",
      bytes: "aGVsbG8=",
      width: 640,
      height: 480,
      format: "jpeg",
      ts: 42,
    };
    runtime.emitFromTab(frame);
    expect(port.posted).toContainEqual(frame);
  });

  test("avatar.started from the tab is forwarded to the native port", async () => {
    await feature.handleBotCommand({ type: "avatar.start" });
    runtime.emitFromTab({ type: "avatar.started" });
    expect(port.posted).toContainEqual({ type: "avatar.started" });
  });

  test("non-avatar messages from the tab are ignored", async () => {
    await feature.handleBotCommand({ type: "avatar.start" });

    // A chat message shape is not something the avatar feature should
    // forward — the content-bridge handles those. Even though this
    // message would validate against the extension→bot schema, the
    // avatar feature must leave it for the main router.
    runtime.emitFromTab({
      type: "chat.inbound",
      meetingId: "abc",
      timestamp: "2026-04-15T00:00:00Z",
      fromId: "p-1",
      fromName: "Alice",
      text: "hey",
    });
    expect(port.posted).toHaveLength(0);
  });

  test("schema-invalid messages from the tab are dropped", async () => {
    await feature.handleBotCommand({ type: "avatar.start" });
    // Missing required `bytes` field — must not crash the feature.
    runtime.emitFromTab({
      type: "avatar.frame",
      width: 640,
      height: 480,
      format: "jpeg",
      ts: 1,
    });
    expect(port.posted).toHaveLength(0);
  });

  test("avatar.stop removes the tab and drops state", async () => {
    await feature.handleBotCommand({ type: "avatar.start" });
    await feature.handleBotCommand({ type: "avatar.stop" });
    expect(tabs.removeCalls).toEqual([1]);

    // After stop, a push_viseme must NOT be dispatched (tab id is null).
    await feature.handleBotCommand({
      type: "avatar.push_viseme",
      phoneme: "ah",
      weight: 0.3,
      timestamp: 0,
    });
    expect(tabs.sendMessageCalls).toHaveLength(0);
  });

  test("a second avatar.start tears down the previous tab first", async () => {
    await feature.handleBotCommand({ type: "avatar.start" });
    await feature.handleBotCommand({ type: "avatar.start" });
    // Previous tab removed, new tab created.
    expect(tabs.removeCalls).toEqual([1]);
    expect(tabs.createCalls).toHaveLength(2);
  });

  test("avatar.stop is idempotent", async () => {
    await feature.handleBotCommand({ type: "avatar.stop" });
    await feature.handleBotCommand({ type: "avatar.stop" });
    expect(tabs.removeCalls).toHaveLength(0);
  });

  test("feature.stop() removes any open tab and is idempotent", async () => {
    await feature.handleBotCommand({ type: "avatar.start" });
    await feature.stop();
    expect(tabs.removeCalls).toEqual([1]);
    await feature.stop();
    expect(tabs.removeCalls).toEqual([1]);
  });

  test("tabs.create errors do not crash the feature", async () => {
    tabs.createError = new Error("extension context gone");
    await feature.handleBotCommand({ type: "avatar.start" });
    // No tab id recorded — subsequent viseme is a no-op.
    await feature.handleBotCommand({
      type: "avatar.push_viseme",
      phoneme: "ah",
      weight: 0.3,
      timestamp: 0,
    });
    expect(tabs.sendMessageCalls).toHaveLength(0);
  });

  test("tabs.remove errors do not crash the feature", async () => {
    await feature.handleBotCommand({ type: "avatar.start" });
    tabs.removeError = new Error("tab already gone");
    await feature.handleBotCommand({ type: "avatar.stop" });
    // removeError swallowed; state cleared.
    await feature.handleBotCommand({ type: "avatar.stop" });
    expect(tabs.removeCalls).toEqual([1]);
  });

  test("native port failures on frame forwarding do not crash the feature", async () => {
    await feature.handleBotCommand({ type: "avatar.start" });
    port.failNextPost = true;
    runtime.emitFromTab({
      type: "avatar.frame",
      bytes: "AA==",
      width: 320,
      height: 240,
      format: "jpeg",
      ts: 0,
    });
    // A second frame after the failure still flows.
    runtime.emitFromTab({
      type: "avatar.frame",
      bytes: "Ag==",
      width: 320,
      height: 240,
      format: "jpeg",
      ts: 1,
    });
    expect(port.posted).toHaveLength(1);
  });

  test("handleBotCommand ignores non-avatar bot commands", async () => {
    // Non-avatar commands must not trigger tab operations.
    const msg: BotToExtensionMessage = {
      type: "join",
      meetingUrl: "https://meet.google.com/abc",
      displayName: "Bot",
      consentMessage: "hi",
    };
    await feature.handleBotCommand(msg);
    expect(tabs.createCalls).toHaveLength(0);
    expect(tabs.sendMessageCalls).toHaveLength(0);
  });
});
