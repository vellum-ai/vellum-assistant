/**
 * @jest-environment happy-dom
 */

import { describe, expect, test } from "bun:test";
import type { MutableRefObject } from "react";

import type { ChatEventStream } from "@/domains/chat/api/stream.js";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import type { RuntimeMessage } from "@/domains/chat/api/messages.js";
import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation.js";
import type { ChatDebugRefs, TurnState } from "@/domains/chat/utils/debug-api.js";
import {
  createChatDebugApi,
  diffMessages,
  installChatDebugApi,
} from "@/domains/chat/utils/debug-api.js";

const INITIAL_TURN_STATE: TurnState = {
  phase: "idle",
  pendingQueuedCount: 0,
  activeToolCallCount: 0,
  activeTurnId: null,
  lastTerminalReason: null,
  statusText: null,
  liveWebActivity: {},
};

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function fakeDisplayMessage(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    stableId: "stable-1",
    id: "msg-1",
    role: "assistant",
    content: "hello",
    isStreaming: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

function fakeRuntimeMessage(overrides: Partial<RuntimeMessage> = {}): RuntimeMessage {
  return {
    id: "msg-1",
    role: "assistant",
    content: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeRefs(
  overrides: Partial<ChatDebugRefs> = {},
): ChatDebugRefs {
  return {
    messagesRef: { current: [] } as MutableRefObject<DisplayMessage[]>,
    getTurnState: () => INITIAL_TURN_STATE,
    streamContextRef: { current: null } as MutableRefObject<{
      assistantId: string;
      conversationKey: string;
    } | null>,
    streamRef: { current: null } as MutableRefObject<ChatEventStream | null>,
    streamEpochRef: { current: 0 } as MutableRefObject<number>,
    activeConversationKeyRef: { current: null } as MutableRefObject<string | null>,
    getAssistantId: () => "asst-1",
    reconcileActiveConversation: async () => ({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  diffMessages (pure, most important)
// ---------------------------------------------------------------------------

describe("diffMessages", () => {
  test("empty lists → no drift", () => {
    const result = diffMessages([], []);
    expect(result.localOnly).toEqual([]);
    expect(result.serverOnly).toEqual([]);
    expect(result.contentDrift).toEqual([]);
  });

  test("local orphan (no id) → localOnly", () => {
    const local = [fakeDisplayMessage({ id: undefined })];
    const result = diffMessages(local, []);
    expect(result.localOnly).toHaveLength(1);
    expect(result.localOnly[0]!.stableId).toBe("stable-1");
  });

  test("server-only message → serverOnly", () => {
    const server = [fakeRuntimeMessage({ id: "srv-1" })];
    const result = diffMessages([], server);
    expect(result.serverOnly).toHaveLength(1);
    expect(result.serverOnly[0]!.id).toBe("srv-1");
  });

  test("matching id + same length → no drift", () => {
    const local = [fakeDisplayMessage({ id: "msg-1", content: "hello" })];
    const server = [fakeRuntimeMessage({ id: "msg-1", content: "hello" })];
    const result = diffMessages(local, server);
    expect(result.localOnly).toHaveLength(0);
    expect(result.serverOnly).toHaveLength(0);
    expect(result.contentDrift).toHaveLength(0);
  });

  test("matching id + different length → contentDrift", () => {
    const local = [fakeDisplayMessage({ id: "msg-1", content: "hello" })];
    const server = [fakeRuntimeMessage({ id: "msg-1", content: "hello world" })];
    const result = diffMessages(local, server);
    expect(result.contentDrift).toHaveLength(1);
    expect(result.contentDrift[0]!.localContentLength).toBe(5);
    expect(result.contentDrift[0]!.serverContentLength).toBe(11);
  });
});

// ---------------------------------------------------------------------------
//  createChatDebugApi — snapshot
// ---------------------------------------------------------------------------

describe("createChatDebugApi.snapshot", () => {
  test("returns timestamps and platform", () => {
    const api = createChatDebugApi(makeRefs());
    const snap = api.snapshot();
    expect(snap.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snap.platform).toBe("web");
  });

  test("reflects messagesRef", () => {
    const messagesRef = { current: [fakeDisplayMessage()] } as MutableRefObject<DisplayMessage[]>;
    const api = createChatDebugApi(makeRefs({ messagesRef }));
    const snap = api.snapshot();
    expect(snap.messages.total).toBe(1);
  });

  test("counts streaming bubbles", () => {
    const messagesRef = {
      current: [
        fakeDisplayMessage({ isStreaming: true }),
        fakeDisplayMessage({ isStreaming: true }),
      ],
    } as MutableRefObject<DisplayMessage[]>;
    const api = createChatDebugApi(makeRefs({ messagesRef }));
    const snap = api.snapshot();
    expect(snap.messages.streamingCount).toBe(2);
    expect(snap.invariants.singleStreamingBubble.ok).toBe(false);
    expect(snap.invariants.singleStreamingBubble.streamingCount).toBe(2);
  });

  test("reflects turn state via getTurnState", () => {
    const turnState: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "thinking",
      activeToolCallCount: 3,
    };
    const api = createChatDebugApi(
      makeRefs({ getTurnState: () => turnState }),
    );
    const snap = api.snapshot();
    expect(snap.turn.phase).toBe("thinking");
    expect(snap.turn.activeToolCallCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
//  createChatDebugApi — diffAgainstServer
// ---------------------------------------------------------------------------

describe("createChatDebugApi.diffAgainstServer", () => {
  test("throws when no context or assistant", async () => {
    const api = createChatDebugApi(
      makeRefs({ getAssistantId: () => null, activeConversationKeyRef: { current: null } }),
    );
    await expect(api.diffAgainstServer()).rejects.toThrow(
      "no active assistant/conversation context",
    );
  });

  test("uses injected historyFetcher", async () => {
    const activeConversationKeyRef = { current: "conv-1" } as MutableRefObject<string | null>;
    const serverMessages = [fakeRuntimeMessage({ id: "srv-1" })];
    const historyFetcher = async () => serverMessages;
    const api = createChatDebugApi(makeRefs({ historyFetcher, activeConversationKeyRef }));
    const result = await api.diffAgainstServer();
    expect(result.context.assistantId).toBe("asst-1");
    expect(result.serverTotal).toBe(1);
    expect(result.serverOnly).toHaveLength(1);
  });

  test("reports orphan when local has no id", async () => {
    const messagesRef = {
      current: [fakeDisplayMessage({ id: undefined })],
    } as MutableRefObject<DisplayMessage[]>;
    const activeConversationKeyRef = { current: "conv-1" } as MutableRefObject<string | null>;
    const historyFetcher = async () => [];
    const api = createChatDebugApi(makeRefs({ messagesRef, historyFetcher, activeConversationKeyRef }));
    const result = await api.diffAgainstServer();
    expect(result.localOnly).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  createChatDebugApi — forceReconcile
// ---------------------------------------------------------------------------

describe("createChatDebugApi.forceReconcile", () => {
  test("returns reconcile result", async () => {
    const reconcileResult: ReconcileActiveConversationResult = {
      changed: true,
      messagesAdded: 2,
      assistantProgress: true,
    };
    const api = createChatDebugApi(
      makeRefs({ reconcileActiveConversation: async () => reconcileResult }),
    );
    const result = await api.forceReconcile();
    expect(result).toEqual(reconcileResult);
  });
});

// ---------------------------------------------------------------------------
//  createChatDebugApi — tailEvents / help
// ---------------------------------------------------------------------------

describe("createChatDebugApi.tailEvents", () => {
  test("returns empty when no diagnostics recorded", () => {
    const api = createChatDebugApi(makeRefs());
    const events = api.tailEvents();
    expect(Array.isArray(events)).toBe(true);
  });
});

describe("createChatDebugApi.help", () => {
  test("mentions every public method", () => {
    const api = createChatDebugApi(makeRefs());
    const text = api.help();
    expect(text).toContain(".snapshot()");
    expect(text).toContain(".tailEvents");
    expect(text).toContain(".forceReconcile()");
    expect(text).toContain(".diffAgainstServer()");
  });
});

// ---------------------------------------------------------------------------
//  installChatDebugApi
// ---------------------------------------------------------------------------

describe("installChatDebugApi", () => {
  test("attaches to window._vellumDebug.chat", () => {
    const api = createChatDebugApi(makeRefs());
    const uninstall = installChatDebugApi(api);
    expect(
      (globalThis as unknown as Window & { _vellumDebug?: { chat?: unknown } })
        ._vellumDebug?.chat,
    ).toBe(api);
    uninstall();
  });

  test("removes on uninstall", () => {
    const api = createChatDebugApi(makeRefs());
    const uninstall = installChatDebugApi(api);
    uninstall();
    expect(
      (globalThis as unknown as Window & { _vellumDebug?: { chat?: unknown } })
        ._vellumDebug?.chat,
    ).toBeUndefined();
  });

  test("preserves sibling debug namespaces when uninstalling", () => {
    const win = globalThis as {
      window: { _vellumDebug?: { chat?: unknown; other?: unknown } };
    };
    win.window._vellumDebug = { other: "keep" };

    const api = createChatDebugApi(makeRefs());
    const uninstall = installChatDebugApi(api);
    uninstall();
    expect(win.window._vellumDebug?.chat).toBeUndefined();
    expect(win.window._vellumDebug?.other).toBeDefined();
  });
});
