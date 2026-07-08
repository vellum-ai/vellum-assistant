import { describe, expect, test } from "bun:test";
import type { MutableRefObject } from "react";

import type { TranscriptHandle } from "@/domains/chat/transcript/transcript";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ConversationMessage } from "@vellumai/assistant-api";
import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation";
import type {
  ChatDebugRefs,
  PendingInteractionsSnapshot,
} from "@/domains/chat/utils/debug-api";
import {
  RECONCILIATION_DIAGNOSTIC_KIND_PREFIXES,
  createChatDebugApi,
  installVellumDebugApi,
} from "@/domains/chat/utils/debug-api";
import {
  recordDiagnostic,
  recordLifecycleDiagnostic,
} from "@/lib/diagnostics";
import {
  INITIAL_TURN_STATE,
  type TurnState,
} from "@/domains/chat/turn-store";
import type { UIContext } from "@/domains/chat/turn-selectors";
import { useConversationStore } from "@/stores/conversation-store";

import {
  makeServerMessage,
  textBody,
  wireTextBody,
} from "@/domains/chat/utils/message-test-helpers";
// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function fakeDisplayMessage(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: "msg-1",
    role: "assistant",
    ...textBody("hello"),
    timestamp: Date.now(),
    ...overrides,
  };
}

function fakeRuntimeMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return makeServerMessage({
    id: "msg-1",
    role: "assistant",
    ...wireTextBody("hello"),
    ...overrides,
  });
}

const DEFAULT_UI_CONTEXT: UIContext = {
  hasStreamingAssistantMessage: false,
  hasStreamingAssistantThinking: false,
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
    sanitizedMessagesRef: { current: [] } as MutableRefObject<DisplayMessage[]>,
    transcriptItemsRef: { current: [] } as MutableRefObject<TranscriptItem[]>,
    transcriptRef: { current: null as TranscriptHandle | null },

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
//  createChatDebugApi — getClientMessages
// ---------------------------------------------------------------------------

describe("createChatDebugApi.getClientMessages", () => {
  test("empty sanitizedMessagesRef → empty result", () => {
    const api = createChatDebugApi(makeRefs());
    const result = api.getClientMessages();
    expect(result).toEqual([]);
  });

  test("returns the underlying DisplayMessage objects untouched", () => {
    const message = fakeDisplayMessage({ ...textBody("hello world") });
    const sanitizedMessagesRef = {
      current: [message],
    } as MutableRefObject<DisplayMessage[]>;
    const api = createChatDebugApi(makeRefs({ sanitizedMessagesRef }));
    const result = api.getClientMessages();
    expect(result).toHaveLength(1);
    // Identity check — debug API must NOT project to a bespoke shape.
    expect(result[0]).toBe(message);
  });

  test("respects limit parameter (slices from the end)", () => {
    const items: DisplayMessage[] = Array.from({ length: 30 }, (_, i) =>
      fakeDisplayMessage({ id: `id-${i}` }),
    );
    const sanitizedMessagesRef = {
      current: items,
    } as MutableRefObject<DisplayMessage[]>;
    const api = createChatDebugApi(makeRefs({ sanitizedMessagesRef }));
    const result = api.getClientMessages(5);
    expect(result).toHaveLength(5);
    expect(result[0]!.id).toBe("id-25");
    expect(result[4]!.id).toBe("id-29");
  });

  test("defaults to 20 items when no limit", () => {
    const items: DisplayMessage[] = Array.from({ length: 30 }, (_, i) =>
      fakeDisplayMessage({ id: `id-${i}` }),
    );
    const sanitizedMessagesRef = {
      current: items,
    } as MutableRefObject<DisplayMessage[]>;
    const api = createChatDebugApi(makeRefs({ sanitizedMessagesRef }));
    const result = api.getClientMessages();
    expect(result).toHaveLength(20);
    expect(result[0]!.id).toBe("id-10");
  });

  test("returns all items when fewer than limit", () => {
    const items: DisplayMessage[] = Array.from({ length: 5 }, (_, i) =>
      fakeDisplayMessage({ id: `id-${i}` }),
    );
    const sanitizedMessagesRef = {
      current: items,
    } as MutableRefObject<DisplayMessage[]>;
    const api = createChatDebugApi(makeRefs({ sanitizedMessagesRef }));
    const result = api.getClientMessages(20);
    expect(result).toHaveLength(5);
    expect(result[0]!.id).toBe("id-0");
  });

  test("coerces invalid limit to default", () => {
    const items: DisplayMessage[] = Array.from({ length: 30 }, (_, i) =>
      fakeDisplayMessage({ id: `id-${i}` }),
    );
    const sanitizedMessagesRef = {
      current: items,
    } as MutableRefObject<DisplayMessage[]>;
    const api = createChatDebugApi(makeRefs({ sanitizedMessagesRef }));
    expect(api.getClientMessages(-1)).toHaveLength(20);
    expect(api.getClientMessages(NaN)).toHaveLength(20);
    expect(api.getClientMessages(Infinity)).toHaveLength(20);
  });

  test("reads from sanitizedMessagesRef, NOT store messages", () => {
    // getClientMessages() is logic-free — it surfaces whatever the render path
    // already wrote to `sanitizedMessagesRef`. Store `messages` is
    // intentionally ignored so DevTools always mirrors the UI.
    const sanitizedOnly = fakeDisplayMessage({ id: "sanitized-only" });
    const api = createChatDebugApi(
      makeRefs({
        sanitizedMessagesRef: {
          current: [sanitizedOnly],
        } as MutableRefObject<DisplayMessage[]>,
      }),
    );
    const result = api.getClientMessages();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("sanitized-only");
  });
});

// ---------------------------------------------------------------------------
//  createChatDebugApi — getTranscriptItems
// ---------------------------------------------------------------------------

describe("createChatDebugApi.getTranscriptItems", () => {
  test("empty transcriptItemsRef → empty array", () => {
    const api = createChatDebugApi(makeRefs());
    expect(api.getTranscriptItems()).toEqual([]);
  });

  test("returns the same array reference the render path wrote", () => {
    // getTranscriptItems() must be logic-free — same array <Transcript />
    // iterates. Identity (===) lets DevTools cross-reference with React
    // DevTools and confirm we're inspecting the live snapshot, not a copy.
    const items: TranscriptItem[] = [
      {
        kind: "message",
        key: "msg-a",
        message: fakeDisplayMessage({ id: "msg-a" }),
      },
      { kind: "thinking", key: "thinking", label: "Processing" },
    ];
    const api = createChatDebugApi(
      makeRefs({
        transcriptItemsRef: { current: items } as MutableRefObject<
          TranscriptItem[]
        >,
      }),
    );
    expect(api.getTranscriptItems()).toBe(items);
  });

  test("surfaces the full discriminated union — not just message rows", () => {
    // The whole point of getTranscriptItems(): inspect non-message rows
    // (thinking, pending prompts, errors) which getClientMessages() doesn't
    // carry.
    const items: TranscriptItem[] = [
      {
        kind: "message",
        key: "msg-a",
        message: fakeDisplayMessage({ id: "msg-a" }),
      },
      { kind: "pendingSecret", key: "ps-1", requestId: "req-1" },
      {
        kind: "pendingConfirmation",
        key: "pc-1",
        requestId: "req-2",
      },
      { kind: "thinking", key: "thinking" },
    ];
    const api = createChatDebugApi(
      makeRefs({
        transcriptItemsRef: { current: items } as MutableRefObject<
          TranscriptItem[]
        >,
      }),
    );
    const result = api.getTranscriptItems();
    expect(result.map((i) => i.kind)).toEqual([
      "message",
      "pendingSecret",
      "pendingConfirmation",
      "thinking",
    ]);
  });

  test("reads from transcriptItemsRef, NOT derived from sanitizedMessagesRef", () => {
    // Contract pin: the API must not synthesize TranscriptItems from
    // DisplayMessages — that would re-run buildTranscriptItems logic
    // and drift from what the UI is actually rendering. The render path
    // owns the projection; this method just exposes its output.
    const msg = fakeDisplayMessage({ id: "from-sanitized" });
    const api = createChatDebugApi(
      makeRefs({
        sanitizedMessagesRef: {
          current: [msg],
        } as MutableRefObject<DisplayMessage[]>,
        // transcriptItemsRef intentionally empty — if the impl projected
        // from sanitizedMessagesRef, we'd get a non-empty result.
        transcriptItemsRef: { current: [] } as MutableRefObject<
          TranscriptItem[]
        >,
      }),
    );
    expect(api.getTranscriptItems()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
//  createChatDebugApi — getPhase
// ---------------------------------------------------------------------------

describe("createChatDebugApi.getPhase", () => {
  test("returns the turn-store phase", () => {
    const api = createChatDebugApi(
      makeRefs({ turn: { ...INITIAL_TURN_STATE, phase: "streaming" } }),
    );
    expect(api.getPhase()).toBe("streaming");
  });

  test("defaults to idle for the initial turn state", () => {
    const api = createChatDebugApi(makeRefs());
    expect(api.getPhase()).toBe("idle");
  });

  test("reads through to getTurnState on every call (no caching)", () => {
    let phase: TurnState["phase"] = "queued";
    const api = createChatDebugApi(
      makeRefs({ getTurnState: () => ({ ...INITIAL_TURN_STATE, phase }) }),
    );
    expect(api.getPhase()).toBe("queued");
    phase = "thinking";
    expect(api.getPhase()).toBe("thinking");
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

  test("queued phase is visible and reported as non-terminal", () => {
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
    expect(snapshot.done.phase).toBe("queued");
    expect(snapshot.done.terminal).toBe(false);
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
//  createChatDebugApi — streamingRing
// ---------------------------------------------------------------------------

describe("createChatDebugApi.streamingRing", () => {
  test("streamingRing is lit while the assistant is busy (thinking)", () => {
    const refs = makeRefs({
      turn: {
        ...INITIAL_TURN_STATE,
        phase: "thinking",
        activeTurnId: "turn-1",
      },
    });
    const api = createChatDebugApi(refs);

    const ring = api.streamingRing();

    expect(ring.visible).toBe(true);
  });

  test("streamingRing is hidden once the turn is idle and nothing is processing", () => {
    const refs = makeRefs({
      turn: {
        ...INITIAL_TURN_STATE,
        phase: "idle",
        lastTerminalReason: "complete",
      },
    });
    const api = createChatDebugApi(refs);

    const ring = api.streamingRing();

    expect(ring.visible).toBe(false);
  });

  test("streamingRing stays lit when the cached snapshot is stale after the turn ends", () => {
    // The hang case: the local turn is terminal (idle, complete) but the
    // cached `conversation.isProcessing` snapshot is still true, so
    // `isAssistantBusy` keeps the ring visible. A terminal `done` plus a
    // visible ring is the signature of a stale-snapshot stuck ring.
    const refs = makeRefs({
      turn: {
        ...INITIAL_TURN_STATE,
        phase: "idle",
        lastTerminalReason: "complete",
      },
      uiContext: { activeConversationIsProcessing: true },
    });
    const api = createChatDebugApi(refs);

    const snapshot = api.thinkingIndicator();
    const ring = api.streamingRing();

    expect(snapshot.done.terminal).toBe(true);
    expect(ring.visible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  createChatDebugApi — serverMessages
// ---------------------------------------------------------------------------

describe("createChatDebugApi.serverMessages", () => {
  test("throws when no context or assistant", async () => {
    useConversationStore.setState({ activeConversationId: null });
    const api = createChatDebugApi(
      makeRefs({ getAssistantId: () => null }),
    );
    await expect(api.serverMessages()).rejects.toThrow(
      "no active assistant/conversation context",
    );
  });

  test("returns the full server snapshot response from injected historyFetcher", async () => {
    // GIVEN an active conversation and a history fetcher returning a
    // snapshot with both messages and a top-level seq watermark
    useConversationStore.setState({ activeConversationId: "conv-1" });
    const serverList = [
      fakeRuntimeMessage({ id: "srv-1" }),
      fakeRuntimeMessage({ id: "srv-2", role: "user" }),
    ];
    const snapshot = { messages: serverList, seq: 7 };
    const historyFetcher = async () => snapshot;
    const api = createChatDebugApi(makeRefs({ historyFetcher }));

    // WHEN serverMessages() is called
    const result = await api.serverMessages();

    // THEN the full response is returned, not just the messages array
    expect(result).toEqual(snapshot);
    // AND the seq watermark survives alongside the messages
    expect(result?.seq).toBe(7);
    expect(result?.messages).toHaveLength(2);
    expect(result?.messages[0]!.id).toBe("srv-1");
  });

  test("prefers stream store context over conversation store + getAssistantId", async () => {
    useConversationStore.setState({ activeConversationId: "conv-fallback" });
    // Set stream context via the stream store.
    const { useStreamStore } = await import("@/domains/chat/stream-store");
    useStreamStore.setState({
      streamContext: { assistantId: "asst-stream", conversationId: "conv-stream" },
    });
    const seen: Array<{ assistantId: string; conversationId: string }> = [];
    const historyFetcher = async (assistantId: string, conversationId: string) => {
      seen.push({ assistantId, conversationId });
      return { messages: [], seq: null };
    };
    const api = createChatDebugApi(
      makeRefs({
        getAssistantId: () => "asst-fallback",
        historyFetcher,
      }),
    );
    await api.serverMessages();
    expect(seen).toEqual([{ assistantId: "asst-stream", conversationId: "conv-stream" }]);
    // Clean up.
    useStreamStore.setState({ streamContext: null });
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
    expect(text).toContain(".getClientMessages(");
    expect(text).toContain(".getTranscriptItems(");
    expect(text).toContain(".getPhase()");
    expect(text).toContain(".thinkingIndicator()");
    expect(text).toContain(".streamingRing()");
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

  test("redacts pending confirmation input values but keeps the arg keys", () => {
    const api = createChatDebugApi(
      makeRefs({
        pendingInteractions: {
          pendingConfirmation: {
            requestId: "req-confirm-1",
            toolName: "http_request",
            input: {
              url: "https://api.example.com",
              api_key: "sk-live-secret-value",
              headers: { Authorization: "Bearer sk-live-secret-value" },
            },
          },
        },
      }),
    );
    const snapshot = api.listPendingInteractions();
    expect(snapshot.pendingConfirmation?.input).toEqual({
      url: "[redacted]",
      api_key: "[redacted]",
      headers: "[redacted]",
    });
  });

  test("redacting input does not mutate the source snapshot", () => {
    const input = { api_key: "sk-live-secret-value" };
    const captured: PendingInteractionsSnapshot = {
      ...DEFAULT_PENDING_INTERACTIONS,
      pendingConfirmation: { requestId: "req-confirm-1", input },
    };
    const api = createChatDebugApi(
      makeRefs({ getPendingInteractionsSnapshot: () => captured }),
    );
    const snapshot = api.listPendingInteractions();
    expect(captured.pendingConfirmation?.input).toBe(input);
    expect(input).toEqual({ api_key: "sk-live-secret-value" });
    expect(snapshot.pendingConfirmation?.input).not.toBe(input);
  });

  test("leaves a confirmation without input untouched", () => {
    const api = createChatDebugApi(
      makeRefs({
        pendingInteractions: {
          pendingConfirmation: {
            requestId: "req-confirm-1",
            title: "Run migration?",
          },
        },
      }),
    );
    const snapshot = api.listPendingInteractions();
    expect(snapshot.pendingConfirmation).toEqual({
      requestId: "req-confirm-1",
      title: "Run migration?",
    });
  });
});

// ---------------------------------------------------------------------------
//  installVellumDebugApi
// ---------------------------------------------------------------------------

type DebugWindow = Window & {
  _vellumDebug?: {
    chat?: unknown;
    events?: { getClients: unknown; getEvents: unknown };
    flags?: {
      impersonateVersion?: (v?: string | null) => string | null;
    };
    other?: unknown;
  };
};

const makeFlagsApi = () => ({
  impersonateVersion: (_value?: string | null): string | null => null,
});

describe("installVellumDebugApi", () => {
  test("attaches .events, .chat, and .flags in one call", () => {
    const api = createChatDebugApi(makeRefs());
    const flags = makeFlagsApi();
    const uninstall = installVellumDebugApi(api, flags);
    const root = (globalThis as unknown as DebugWindow)._vellumDebug;
    expect(root?.chat).toBe(api);
    expect(root?.events).toBeDefined();
    expect(typeof root?.events?.getClients).toBe("function");
    expect(typeof root?.events?.getEvents).toBe("function");
    expect(typeof root?.flags?.impersonateVersion).toBe("function");
    uninstall();
  });

  test("removes .events, .chat, and .flags on uninstall", () => {
    const api = createChatDebugApi(makeRefs());
    const uninstall = installVellumDebugApi(api, makeFlagsApi());
    uninstall();
    const root = (globalThis as unknown as DebugWindow)._vellumDebug;
    // Root should be gone entirely since nothing else was attached.
    expect(root).toBeUndefined();
  });

  test("preserves sibling debug namespaces when uninstalling", () => {
    const win = globalThis as unknown as { window: DebugWindow };
    win.window._vellumDebug = { other: "keep" };

    const api = createChatDebugApi(makeRefs());
    const uninstall = installVellumDebugApi(api, makeFlagsApi());
    uninstall();
    expect(win.window._vellumDebug?.chat).toBeUndefined();
    expect(win.window._vellumDebug?.events).toBeUndefined();
    expect(win.window._vellumDebug?.flags).toBeUndefined();
    expect(win.window._vellumDebug?.other).toBe("keep");

    // Cleanup so we don't leak state into other tests.
    delete win.window._vellumDebug;
  });

  test("identity-checks chat on teardown so a newer mount isn't clobbered", () => {
    const first = createChatDebugApi(makeRefs());
    const uninstallFirst = installVellumDebugApi(first, makeFlagsApi());

    const second = createChatDebugApi(makeRefs());
    installVellumDebugApi(second, makeFlagsApi());

    // First mount's teardown runs after second mount installed —
    // simulates strict-mode double-mount or hot-reload races.
    uninstallFirst();

    const root = (globalThis as unknown as DebugWindow)._vellumDebug;
    expect(root?.chat).toBe(second);
    expect(root?.events).toBeDefined();
    expect(root?.flags).toBeDefined();
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
    scrollToMessage: () => false,
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
    const api = createChatDebugApi(
      makeRefs({
        transcriptRef: { current: makeTranscriptHandle(el) },
        // Non-empty rendered transcript so classifyScrollPosition treats the
        // near-top position as load-older-eligible.
        transcriptItemsRef: {
          current: [
            {
              kind: "message",
              key: "a",
              message: fakeDisplayMessage({ id: "a" }),
            },
          ],
        } as MutableRefObject<TranscriptItem[]>,
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

  test("itemCount comes from the rendered transcript items", () => {
    const el = makeScrollElement({
      scrollTop: 500,
      scrollHeight: 1000,
      clientHeight: 100,
    });
    const api = createChatDebugApi(
      makeRefs({
        transcriptRef: { current: makeTranscriptHandle(el) },
        transcriptItemsRef: {
          current: [
            {
              kind: "message",
              key: "a",
              message: fakeDisplayMessage({ id: "a" }),
            },
            {
              kind: "message",
              key: "b",
              message: fakeDisplayMessage({ id: "b" }),
            },
            {
              kind: "message",
              key: "c",
              message: fakeDisplayMessage({ id: "c" }),
            },
          ],
        } as MutableRefObject<TranscriptItem[]>,
        getScrollPagination: () => ({ hasMore: true, isLoadingOlder: false }),
      }),
    );
    const state = api.getScrollState();
    expect(state.itemCount).toBe(3);
    expect(state.scrollTop).toBe(500);
    expect(state.distanceFromBottom).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  createChatDebugApi — diagnostics ring accessors
// ---------------------------------------------------------------------------

describe("createChatDebugApi diagnostics accessors", () => {
  test("getDiagnostics returns recorded main-ring events, newest last", () => {
    const api = createChatDebugApi(makeRefs());
    recordDiagnostic("test_kind_a", { value: 1 });
    recordDiagnostic("test_kind_b", { value: 2 });
    const events = api.getDiagnostics();
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf("test_kind_a")).toBeLessThan(
      kinds.indexOf("test_kind_b"),
    );
    const last = events.at(-1)!;
    expect(last.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(last.details.value).toBe(2);
  });

  test("getDiagnostics(prefix) filters by kind prefix", () => {
    const api = createChatDebugApi(makeRefs());
    recordDiagnostic("prefix_match_one", {});
    recordDiagnostic("prefix_match_two", {});
    recordDiagnostic("other_kind", {});
    const events = api.getDiagnostics("prefix_match_");
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.every((e) => e.kind.startsWith("prefix_match_"))).toBe(true);
  });

  test("getLifecycleDiagnostics reads the lifecycle ring, not the main ring", () => {
    const api = createChatDebugApi(makeRefs());
    recordLifecycleDiagnostic("lifecycle_only_kind", { source: "test" });
    recordDiagnostic("main_only_kind", {});
    const lifecycle = api.getLifecycleDiagnostics();
    expect(lifecycle.some((e) => e.kind === "lifecycle_only_kind")).toBe(true);
    expect(lifecycle.some((e) => e.kind === "main_only_kind")).toBe(false);
    const filtered = api.getLifecycleDiagnostics("lifecycle_only_");
    expect(filtered.every((e) => e.kind.startsWith("lifecycle_only_"))).toBe(
      true,
    );
  });

  test("getReconciliationDiagnostics returns only reconciliation-related kinds", () => {
    const api = createChatDebugApi(makeRefs());
    recordDiagnostic("reconciliation_applied", { messagesAdded: 1 });
    recordDiagnostic("sse_event_seq_replayed", { eventSeq: 5, localSeq: 900 });
    recordDiagnostic("sse_seq_generation_reset", { eventSeq: 1 });
    recordDiagnostic("sse_event_wrong_conversation_filtered", {});
    recordDiagnostic("unrelated_kind", {});
    const events = api.getReconciliationDiagnostics();
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("reconciliation_applied");
    expect(kinds).toContain("sse_event_seq_replayed");
    expect(kinds).toContain("sse_seq_generation_reset");
    expect(kinds).toContain("sse_event_wrong_conversation_filtered");
    expect(kinds).not.toContain("unrelated_kind");
    expect(
      kinds.every((kind) =>
        RECONCILIATION_DIAGNOSTIC_KIND_PREFIXES.some((prefix) =>
          kind.startsWith(prefix),
        ),
      ),
    ).toBe(true);
  });

  test("returned events are defensive copies", () => {
    const api = createChatDebugApi(makeRefs());
    recordDiagnostic("copy_check_kind", { value: "original" });
    const first = api.getDiagnostics("copy_check_kind");
    first.at(-1)!.details.value = "mutated";
    const second = api.getDiagnostics("copy_check_kind");
    expect(second.at(-1)!.details.value).toBe("original");
  });
});
