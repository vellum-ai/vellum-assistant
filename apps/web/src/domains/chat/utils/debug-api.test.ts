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
//  createChatDebugApi — serverMessages
// ---------------------------------------------------------------------------

describe("createChatDebugApi.serverMessages", () => {
  test("throws when no context or assistant", async () => {
    const api = createChatDebugApi(
      makeRefs({ getAssistantId: () => null, activeConversationKeyRef: { current: null } }),
    );
    await expect(api.serverMessages()).rejects.toThrow(
      "no active assistant/conversation context",
    );
  });

  test("returns raw RuntimeMessage[] from injected historyFetcher", async () => {
    const activeConversationKeyRef = { current: "conv-1" } as MutableRefObject<string | null>;
    const serverList = [
      fakeRuntimeMessage({ id: "srv-1" }),
      fakeRuntimeMessage({ id: "srv-2", role: "user" }),
    ];
    const historyFetcher = async () => serverList;
    const api = createChatDebugApi(makeRefs({ historyFetcher, activeConversationKeyRef }));
    const result = await api.serverMessages();
    expect(result).toBe(serverList);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("srv-1");
  });

  test("prefers streamContextRef over activeConversationKeyRef + getAssistantId", async () => {
    const activeConversationKeyRef = { current: "conv-fallback" } as MutableRefObject<string | null>;
    const streamContextRef = {
      current: { assistantId: "asst-stream", conversationKey: "conv-stream" },
    } as MutableRefObject<{ assistantId: string; conversationKey: string } | null>;
    const seen: Array<{ assistantId: string; conversationKey: string }> = [];
    const historyFetcher = async (assistantId: string, conversationKey: string) => {
      seen.push({ assistantId, conversationKey });
      return [];
    };
    const api = createChatDebugApi(
      makeRefs({
        getAssistantId: () => "asst-fallback",
        streamContextRef,
        activeConversationKeyRef,
        historyFetcher,
      }),
    );
    await api.serverMessages();
    expect(seen).toEqual([{ assistantId: "asst-stream", conversationKey: "conv-stream" }]);
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
    expect(text).toContain(".serverMessages()");
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
