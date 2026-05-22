/**
 * @jest-environment happy-dom
 */

import { describe, expect, test } from "bun:test";
import type { MutableRefObject } from "react";

import type { ChatEventStream } from "@/domains/chat/api/stream.js";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import type { RuntimeMessage } from "@/domains/chat/api/messages.js";
import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation.js";
import type { TranscriptItem } from "@/domains/chat/transcript/types.js";
import type { ChatDebugRefs } from "@/domains/chat/utils/debug-api.js";
import {
  createChatDebugApi,
  diffMessages,
  installChatDebugApi,
} from "@/domains/chat/utils/debug-api.js";

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

function fakeMessageItem(message: DisplayMessage): TranscriptItem {
  return {
    kind: "message",
    key: message.stableId,
    message,
  };
}

function fakeThinkingItem(label?: string): TranscriptItem {
  return {
    kind: "thinking",
    key: "thinking",
    ...(label ? { label } : {}),
  };
}

function makeRefs(
  overrides: Partial<ChatDebugRefs> = {},
): ChatDebugRefs {
  return {
    messagesRef: { current: [] } as MutableRefObject<DisplayMessage[]>,
    transcriptItemsRef: { current: [] } as MutableRefObject<TranscriptItem[]>,
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
//  createChatDebugApi — tail
// ---------------------------------------------------------------------------

describe("createChatDebugApi.tail", () => {
  test("empty transcript → empty tail", () => {
    const api = createChatDebugApi(makeRefs());
    const result = api.tail();
    expect(result).toEqual([]);
  });

  test("returns message items with correct shape", () => {
    const message = fakeDisplayMessage({ content: "hello world" });
    const transcriptItemsRef = {
      current: [fakeMessageItem(message)],
    } as MutableRefObject<TranscriptItem[]>;
    const api = createChatDebugApi(makeRefs({ transcriptItemsRef }));
    const result = api.tail();
    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.kind).toBe("message");
    expect(item.index).toBe(0);
    expect(item.key).toBe("stable-1");
    expect((item as { role: string }).role).toBe("assistant");
    expect((item as { contentLength: number }).contentLength).toBe(11);
  });

  test("returns thinking items", () => {
    const transcriptItemsRef = {
      current: [fakeThinkingItem("Processing...")],
    } as MutableRefObject<TranscriptItem[]>;
    const api = createChatDebugApi(makeRefs({ transcriptItemsRef }));
    const result = api.tail();
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("thinking");
    expect((result[0] as { label: string | null }).label).toBe("Processing...");
  });

  test("respects limit parameter", () => {
    const items: TranscriptItem[] = Array.from({ length: 30 }, (_, i) =>
      fakeMessageItem(fakeDisplayMessage({ stableId: `msg-${i}`, id: `id-${i}` })),
    );
    const transcriptItemsRef = { current: items } as MutableRefObject<TranscriptItem[]>;
    const api = createChatDebugApi(makeRefs({ transcriptItemsRef }));
    const result = api.tail(5);
    expect(result).toHaveLength(5);
    expect(result[0]!.index).toBe(25);
    expect(result[4]!.index).toBe(29);
  });

  test("defaults to 20 items when no limit", () => {
    const items: TranscriptItem[] = Array.from({ length: 30 }, (_, i) =>
      fakeMessageItem(fakeDisplayMessage({ stableId: `msg-${i}`, id: `id-${i}` })),
    );
    const transcriptItemsRef = { current: items } as MutableRefObject<TranscriptItem[]>;
    const api = createChatDebugApi(makeRefs({ transcriptItemsRef }));
    const result = api.tail();
    expect(result).toHaveLength(20);
  });

  test("returns all items when fewer than limit", () => {
    const items: TranscriptItem[] = Array.from({ length: 5 }, (_, i) =>
      fakeMessageItem(fakeDisplayMessage({ stableId: `msg-${i}`, id: `id-${i}` })),
    );
    const transcriptItemsRef = { current: items } as MutableRefObject<TranscriptItem[]>;
    const api = createChatDebugApi(makeRefs({ transcriptItemsRef }));
    const result = api.tail(20);
    expect(result).toHaveLength(5);
    expect(result[0]!.index).toBe(0);
  });

  test("coerces invalid limit to default", () => {
    const items: TranscriptItem[] = Array.from({ length: 30 }, (_, i) =>
      fakeMessageItem(fakeDisplayMessage({ stableId: `msg-${i}`, id: `id-${i}` })),
    );
    const transcriptItemsRef = { current: items } as MutableRefObject<TranscriptItem[]>;
    const api = createChatDebugApi(makeRefs({ transcriptItemsRef }));
    expect(api.tail(-1)).toHaveLength(20);
    expect(api.tail(NaN)).toHaveLength(20);
    expect(api.tail(Infinity)).toHaveLength(20);
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
//  createChatDebugApi — help
// ---------------------------------------------------------------------------

describe("createChatDebugApi.help", () => {
  test("mentions every public method", () => {
    const api = createChatDebugApi(makeRefs());
    const consoleSpy = {
      logged: [] as string[],
      log: (msg: string) => {
        consoleSpy.logged.push(msg);
      },
    };
    const originalLog = console.log;
    console.log = consoleSpy.log as unknown as typeof console.log;
    api.help();
    console.log = originalLog;

    const text = consoleSpy.logged.join("\n");
    expect(text).toContain(".tail(");
    expect(text).toContain(".forceReconcile()");
    expect(text).toContain(".diffAgainstServer()");
    expect(text).toContain("[experimental]");
  });

  test("returns undefined", () => {
    const api = createChatDebugApi(makeRefs());
    const result = api.help();
    expect(result).toBeUndefined();
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
