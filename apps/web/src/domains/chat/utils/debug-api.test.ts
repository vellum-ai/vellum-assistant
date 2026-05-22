/**
 * @jest-environment happy-dom
 */

import { describe, expect, test } from "bun:test";
import type { MutableRefObject } from "react";

import type { ChatEventStream } from "@/domains/chat/api/stream.js";
import type { TranscriptHandle } from "@/domains/chat/transcript/use-transcript-scroll.js";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import type { RuntimeMessage } from "@/domains/chat/api/messages.js";
import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation.js";
import type { TranscriptItem } from "@/domains/chat/transcript/types.js";
import type {
  ChatDebugRefs,
  PendingInteractionsSnapshot,
} from "@/domains/chat/utils/debug-api.js";
import {
  createChatDebugApi,
  installChatDebugApi,
} from "@/domains/chat/utils/debug-api.js";
import {
  INITIAL_TURN_STATE,
  type TurnState,
} from "@/domains/messaging/turn-store.js";
import type { UIContext } from "@/domains/messaging/turn-selectors.js";

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

const DEFAULT_UI_CONTEXT: UIContext = {
  hasStreamingAssistantMessage: false,
  hasPendingSecret: false,
  hasPendingConfirmation: false,
  hasPendingQuestion: false,
  hasPendingContactRequest: false,
  hasUncompletedVisibleSurface: false,
  activeConversationIsProcessing: false,
  hasPendingAssistantResponse: false,
};

const DEFAULT_PENDING_INTERACTIONS: PendingInteractionsSnapshot = {
  pendingSecret: null,
  isSubmittingSecret: false,
  pendingConfirmation: null,
  isSubmittingConfirmation: false,
  pendingContactRequest: null,
  isSubmittingContactRequest: false,
  pendingQuestion: null,
  isSubmittingQuestion: false,
  isQuestionCardDismissed: false,
  inlineConfirmationToolCallId: null,
};

interface MakeRefsOverrides extends Partial<ChatDebugRefs> {
  /** Convenience: override the TurnState surface returned by `getTurnState`. */
  turn?: TurnState;
  /** Convenience: partial UIContext merged onto {@link DEFAULT_UI_CONTEXT}. */
  uiContext?: Partial<UIContext>;
  /** Convenience: partial snapshot merged onto {@link DEFAULT_PENDING_INTERACTIONS}. */
  pendingInteractions?: Partial<PendingInteractionsSnapshot>;
}

function makeRefs(
  overrides: MakeRefsOverrides = {},
): ChatDebugRefs {
  const { turn, uiContext, pendingInteractions, ...rest } = overrides;
  const turnState: TurnState = turn ?? INITIAL_TURN_STATE;
  const resolvedUIContext: UIContext = {
    ...DEFAULT_UI_CONTEXT,
    ...(uiContext ?? {}),
  };
  const resolvedPendingInteractions: PendingInteractionsSnapshot = {
    ...DEFAULT_PENDING_INTERACTIONS,
    ...(pendingInteractions ?? {}),
  };
  return {
    messagesRef: { current: [] } as MutableRefObject<DisplayMessage[]>,
    transcriptItemsRef: { current: [] } as MutableRefObject<TranscriptItem[]>,
    transcriptRef: { current: null as TranscriptHandle | null },
    streamContextRef: { current: null } as MutableRefObject<{
      assistantId: string;
      conversationKey: string;
    } | null>,
    streamRef: { current: null } as MutableRefObject<ChatEventStream | null>,
    streamEpochRef: { current: 0 } as MutableRefObject<number>,
    activeConversationKeyRef: { current: null } as MutableRefObject<string | null>,
    getAssistantId: () => "asst-1",
    getTurnState: () => turnState,
    getUIContext: () => resolvedUIContext,
    getPendingInteractionsSnapshot: () => resolvedPendingInteractions,
    getScrollPagination: () => ({ hasMore: false, isLoadingOlder: false }),
    reconcileActiveConversation: async () => ({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    }),
    ...rest,
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
//  createChatDebugApi — thinkingIndicator
// ---------------------------------------------------------------------------

describe("createChatDebugApi.thinkingIndicator", () => {
  test("phase=thinking with quiet UI context → visible, no failing conditions, active", () => {
    const refs = makeRefs({
      turn: {
        ...INITIAL_TURN_STATE,
        phase: "thinking",
        activeTurnId: "turn-1",
        statusText: "Thinking",
      },
    });
    const api = createChatDebugApi(refs);

    const snapshot = api.thinkingIndicator();

    expect(snapshot.visible).toBe(true);
    expect(snapshot.failingConditions).toEqual([]);
    expect(snapshot.conditions.isSending).toBe(true);
    expect(snapshot.conditions.isThinking).toBe(true);
    expect(snapshot.conditions.activeToolCallCount).toBe(0);
    expect(snapshot.conditions.statusText).toBe("Thinking");
    expect(snapshot.done.terminal).toBe(false);
    expect(snapshot.done.phase).toBe("thinking");
    expect(snapshot.done.lastTerminalReason).toBeNull();
    expect(snapshot.done.explanation).toBe("active: phase=thinking");
  });

  test("initial state → hidden with notSendingAndNotRestoredProcessing flag and terminal=true", () => {
    const refs = makeRefs();
    const api = createChatDebugApi(refs);

    const snapshot = api.thinkingIndicator();

    expect(snapshot.visible).toBe(false);
    expect(snapshot.failingConditions).toEqual([
      "notSendingAndNotRestoredProcessing",
    ]);
    expect(snapshot.done.terminal).toBe(true);
    expect(snapshot.done.phase).toBe("idle");
    expect(snapshot.done.lastTerminalReason).toBeNull();
    expect(snapshot.done.explanation).toBe(
      "terminal: phase=idle, no prior turn this session",
    );
  });

  test("terminal phase=idle after MESSAGE_COMPLETE → done.lastTerminalReason=\"complete\"", () => {
    const refs = makeRefs({
      turn: {
        ...INITIAL_TURN_STATE,
        phase: "idle",
        lastTerminalReason: "complete",
      },
    });
    const api = createChatDebugApi(refs);

    const snapshot = api.thinkingIndicator();

    expect(snapshot.visible).toBe(false);
    expect(snapshot.done.terminal).toBe(true);
    expect(snapshot.done.lastTerminalReason).toBe("complete");
    expect(snapshot.done.explanation).toBe(
      "terminal: phase=idle, lastTerminalReason=complete",
    );
  });

  test("streaming with assistant message in flight → hidden with streamingAssistantMessageActive", () => {
    const refs = makeRefs({
      turn: {
        ...INITIAL_TURN_STATE,
        phase: "streaming",
        activeTurnId: "turn-1",
      },
      uiContext: { hasStreamingAssistantMessage: true },
    });
    const api = createChatDebugApi(refs);

    const snapshot = api.thinkingIndicator();

    expect(snapshot.visible).toBe(false);
    expect(snapshot.failingConditions).toEqual([
      "streamingAssistantMessageActive",
    ]);
    expect(snapshot.done.terminal).toBe(false);
    expect(snapshot.done.explanation).toBe(
      "active: phase=streaming, streaming an assistant message",
    );
  });

  test("active tool call suppresses indicator (activeToolCallCount>0)", () => {
    const refs = makeRefs({
      turn: {
        ...INITIAL_TURN_STATE,
        phase: "thinking",
        activeTurnId: "turn-1",
        activeToolCallCount: 1,
      },
    });
    const api = createChatDebugApi(refs);

    const snapshot = api.thinkingIndicator();

    expect(snapshot.visible).toBe(false);
    expect(snapshot.failingConditions).toEqual(["activeToolCallCount>0"]);
    expect(snapshot.conditions.activeToolCallCount).toBe(1);
    expect(snapshot.done.explanation).toBe(
      "active: phase=thinking, activeToolCallCount=1",
    );
  });

  test("each pending-prompt gate is reported individually", () => {
    const baseTurn: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "awaiting_user_input",
      activeTurnId: "turn-1",
    };
    const cases: Array<{ field: keyof UIContext; expected: string }> = [
      { field: "hasPendingSecret", expected: "hasPendingSecret" },
      { field: "hasPendingConfirmation", expected: "hasPendingConfirmation" },
      { field: "hasPendingQuestion", expected: "hasPendingQuestion" },
      {
        field: "hasPendingContactRequest",
        expected: "hasPendingContactRequest",
      },
      {
        field: "hasUncompletedVisibleSurface",
        expected: "hasUncompletedVisibleSurface",
      },
    ];

    for (const { field, expected } of cases) {
      const refs = makeRefs({
        turn: baseTurn,
        uiContext: { [field]: true } as Partial<UIContext>,
      });
      const api = createChatDebugApi(refs);
      const snapshot = api.thinkingIndicator();
      expect(snapshot.visible).toBe(false);
      expect(snapshot.failingConditions).toContain(expected);
    }
  });

  test("restoredProcessing keeps the indicator visible after a conversation switch", () => {
    // Mirrors the resumed-conversation case: reducer is idle (because the
    // local turn state machine was reset by the switch) but the active
    // conversation list says this conversation is still processing AND there's
    // a user message with no assistant reply yet.
    const refs = makeRefs({
      turn: INITIAL_TURN_STATE,
      uiContext: {
        activeConversationIsProcessing: true,
        hasPendingAssistantResponse: true,
      },
    });
    const api = createChatDebugApi(refs);

    const snapshot = api.thinkingIndicator();

    expect(snapshot.conditions.restoredProcessing).toBe(true);
    expect(snapshot.visible).toBe(true);
    expect(snapshot.failingConditions).toEqual([]);
    // Phase is still idle locally — but `restoredProcessing` overrides.
    expect(snapshot.done.terminal).toBe(true);
  });

  test("queued phase reports queue depth in explanation", () => {
    const refs = makeRefs({
      turn: {
        ...INITIAL_TURN_STATE,
        phase: "queued",
        pendingQueuedCount: 2,
      },
    });
    const api = createChatDebugApi(refs);

    const snapshot = api.thinkingIndicator();

    expect(snapshot.visible).toBe(true);
    expect(snapshot.done.explanation).toBe("active: phase=queued, pending=2");
  });

  test("returns the same UIContext reference shape getUIContext provided", () => {
    // Defends the API's contract: the snapshot mirrors what the predicate
    // saw, so a developer comparing `snapshot.uiContext` to the values in
    // React DevTools sees the same object shape.
    const refs = makeRefs({
      uiContext: { hasUncompletedVisibleSurface: true },
    });
    const api = createChatDebugApi(refs);
    const snapshot = api.thinkingIndicator();
    expect(snapshot.uiContext.hasUncompletedVisibleSurface).toBe(true);
    expect(snapshot.uiContext.hasPendingSecret).toBe(false);
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
    expect(text).toContain(".thinkingIndicator()");
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
//  createChatDebugApi — listPendingInteractions
// ---------------------------------------------------------------------------

describe("createChatDebugApi.listPendingInteractions", () => {
  test("returns the empty snapshot when no prompts are pending", () => {
    const api = createChatDebugApi(makeRefs());
    const snapshot = api.listPendingInteractions();
    expect(snapshot).toEqual(DEFAULT_PENDING_INTERACTIONS);
  });

  test("forwards pending secret + submission flag from the snapshot getter", () => {
    const api = createChatDebugApi(
      makeRefs({
        pendingInteractions: {
          pendingSecret: {
            requestId: "req-secret-1",
            label: "OpenAI API Key",
            description: "needed for inference",
          },
          isSubmittingSecret: true,
        },
      }),
    );
    const snapshot = api.listPendingInteractions();
    expect(snapshot.pendingSecret).toEqual({
      requestId: "req-secret-1",
      label: "OpenAI API Key",
      description: "needed for inference",
    });
    expect(snapshot.isSubmittingSecret).toBe(true);
    // Unrelated prompt slots remain null/false.
    expect(snapshot.pendingConfirmation).toBeNull();
    expect(snapshot.pendingContactRequest).toBeNull();
    expect(snapshot.pendingQuestion).toBeNull();
  });

  test("forwards pending question + card-dismissed flag", () => {
    const api = createChatDebugApi(
      makeRefs({
        pendingInteractions: {
          pendingQuestion: {
            requestId: "req-question-1",
            entries: [],
          },
          isQuestionCardDismissed: true,
        },
      }),
    );
    const snapshot = api.listPendingInteractions();
    expect(snapshot.pendingQuestion?.requestId).toBe("req-question-1");
    expect(snapshot.isQuestionCardDismissed).toBe(true);
  });

  test("reads through to the getter on every call (no caching)", () => {
    let captured: PendingInteractionsSnapshot = {
      ...DEFAULT_PENDING_INTERACTIONS,
    };
    const api = createChatDebugApi(
      makeRefs({ getPendingInteractionsSnapshot: () => captured }),
    );
    expect(api.listPendingInteractions().pendingConfirmation).toBeNull();

    captured = {
      ...DEFAULT_PENDING_INTERACTIONS,
      pendingConfirmation: {
        requestId: "req-confirm-1",
        title: "Run migration?",
        description: "irreversible",
        riskLevel: "high",
      },
      isSubmittingConfirmation: true,
      inlineConfirmationToolCallId: "tc-42",
    };
    const second = api.listPendingInteractions();
    expect(second.pendingConfirmation?.requestId).toBe("req-confirm-1");
    expect(second.isSubmittingConfirmation).toBe(true);
    expect(second.inlineConfirmationToolCallId).toBe("tc-42");
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

// ---------------------------------------------------------------------------
//  createChatDebugApi.getScrollState (ATL-644)
//
// `transcriptRef` and `getScrollPagination` are passed through the shared
// `ChatDebugRefs` so tests just provide them in the makeRefs override.
// ---------------------------------------------------------------------------

function makeScrollElement(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", {
    value: metrics.scrollTop,
    writable: false,
  });
  Object.defineProperty(el, "scrollHeight", {
    value: metrics.scrollHeight,
    writable: false,
  });
  Object.defineProperty(el, "clientHeight", {
    value: metrics.clientHeight,
    writable: false,
  });
  return el;
}

function makeTranscriptHandle(
  scrollEl: HTMLDivElement | null,
): TranscriptHandle {
  return {
    scrollToLatest: () => {},
    getScrollElement: () => scrollEl,
    getContentElement: () => null,
    getViewportHeight: () => scrollEl?.clientHeight ?? 0,
    getScrollState: () => ({
      distanceFromBottom: 0,
      isPinned: true,
      showScrollToLatest: false,
      shouldLoadOlder: false,
    }),
  };
}

describe("createChatDebugApi.getScrollState", () => {
  test("transcript not mounted (transcriptRef.current null) → diagnosis", () => {
    const api = createChatDebugApi(
      makeRefs({
        transcriptRef: { current: null },
        getScrollPagination: () => ({ hasMore: true, isLoadingOlder: false }),
      }),
    );
    const state = api.getScrollState();
    expect(state.scrollTop).toBeNull();
    expect(state.scrollHeight).toBeNull();
    expect(state.clientHeight).toBeNull();
    expect(state.isPinnedToLatest).toBeNull();
    expect(state.showScrollToLatest).toBeNull();
    expect(state.shouldLoadOlder).toBe(false);
    expect(state.hasMore).toBe(true);
    expect(state.itemCount).toBe(0);
    expect(state.diagnosis).toContain("not mounted");
  });

  test("pinned to bottom → isPinnedToLatest=true, shouldLoadOlder=false", () => {
    const el = makeScrollElement({
      scrollTop: 900,
      scrollHeight: 1000,
      clientHeight: 100,
    });
    const api = createChatDebugApi(
      makeRefs({
        transcriptRef: { current: makeTranscriptHandle(el) },
        getScrollPagination: () => ({ hasMore: true, isLoadingOlder: false }),
      }),
    );
    const state = api.getScrollState();
    expect(state.scrollTop).toBe(900);
    expect(state.distanceFromBottom).toBe(0);
    expect(state.isPinnedToLatest).toBe(true);
    expect(state.showScrollToLatest).toBe(false);
    expect(state.shouldLoadOlder).toBe(false);
    expect(state.diagnosis).toContain("Pinned to bottom");
  });

  test("far from bottom → showScrollToLatest=true", () => {
    const el = makeScrollElement({
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 100,
    });
    // Non-empty conversation so classifyScrollPosition treats the
    // near-top position as load-older-eligible.
    const messagesRef = {
      current: [fakeDisplayMessage()],
    } as MutableRefObject<DisplayMessage[]>;
    const api = createChatDebugApi(
      makeRefs({
        messagesRef,
        transcriptRef: { current: makeTranscriptHandle(el) },
        getScrollPagination: () => ({ hasMore: true, isLoadingOlder: false }),
      }),
    );
    const state = api.getScrollState();
    expect(state.scrollTop).toBe(0);
    expect(state.distanceFromBottom).toBe(900);
    expect(state.distanceFromTop).toBe(0);
    expect(state.isPinnedToLatest).toBe(false);
    expect(state.showScrollToLatest).toBe(true);
    expect(state.itemCount).toBe(1);
  });

  test("hasMore=false → diagnosis says no more history", () => {
    const el = makeScrollElement({
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 100,
    });
    const api = createChatDebugApi(
      makeRefs({
        transcriptRef: { current: makeTranscriptHandle(el) },
        getScrollPagination: () => ({ hasMore: false, isLoadingOlder: false }),
      }),
    );
    const state = api.getScrollState();
    expect(state.hasMore).toBe(false);
    expect(state.shouldLoadOlder).toBe(false);
    expect(state.diagnosis).toContain("no more history");
  });

  test("isLoadingOlder=true → diagnosis confirms scroll handler fired", () => {
    const el = makeScrollElement({
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 100,
    });
    const api = createChatDebugApi(
      makeRefs({
        transcriptRef: { current: makeTranscriptHandle(el) },
        getScrollPagination: () => ({ hasMore: true, isLoadingOlder: true }),
      }),
    );
    const state = api.getScrollState();
    expect(state.isLoadingOlder).toBe(true);
    expect(state.diagnosis).toContain("Already loading older");
  });

  test("itemCount comes from messagesRef on the base API", () => {
    const el = makeScrollElement({
      scrollTop: 500,
      scrollHeight: 1000,
      clientHeight: 100,
    });
    const messagesRef = {
      current: [
        fakeDisplayMessage({ stableId: "a" }),
        fakeDisplayMessage({ stableId: "b" }),
        fakeDisplayMessage({ stableId: "c" }),
      ],
    } as MutableRefObject<DisplayMessage[]>;
    const api = createChatDebugApi(
      makeRefs({
        messagesRef,
        transcriptRef: { current: makeTranscriptHandle(el) },
        getScrollPagination: () => ({ hasMore: true, isLoadingOlder: false }),
      }),
    );
    const state = api.getScrollState();
    expect(state.itemCount).toBe(3);
    expect(state.scrollTop).toBe(500);
    expect(state.distanceFromBottom).toBe(400);
  });
});
