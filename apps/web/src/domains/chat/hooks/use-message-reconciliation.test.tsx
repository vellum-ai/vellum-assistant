/**
 * Tests for `useMessageReconciliation`.
 *
 * Since the workspace doesn't ship `@testing-library/react`, we follow the
 * project convention of rendering a tiny component via `renderToStaticMarkup`
 * to capture the hook's return value.  The hook accepts external refs so the
 * test harness controls all mutable state.
 *
 * Key behaviors under test:
 * - `reconcileFromServer`: delegates to the seq-aware snapshot merge
 *   (`reconcileSnapshot`), reports changed vs unchanged.
 * - `reconcileActiveConversation`: orchestrates fetch, reconciliation,
 *   turn-state dispatch (`POLL_RECONCILED`), and stale tool-call cleanup.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import type { DisplayMessage } from "@/domains/chat/types/types";
import {
  isToolCallCompleted,
  isToolCallRunning,
} from "@/domains/chat/utils/tool-call-status";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { INITIAL_TURN_STATE, type TurnState, useTurnStore } from "@/domains/chat/turn-store";
import { useConversationStore } from "@/stores/conversation-store";
import {
  __resetLocalSeqForTesting,
  recordLocalSeq,
} from "@/lib/streaming/local-seq";

// ---------------------------------------------------------------------------
// Mocks — module mocks MUST come before importing the subject under test.
// ---------------------------------------------------------------------------

let mockFetchResult: ConversationMessage[] = [];
let mockFetchSeq: number | null = null;
let mockFetchError: Error | null = null;
let mockFetchSideEffect: (() => void) | null = null;
let fetchCallCount = 0;

// The messages module has side-effect-heavy imports (HeyAPI client, CSRF, etc.)
// that can't load in a test environment. We mock the entire module, providing
// the pure functions that reconcile.ts needs plus our controllable fetch stub.
//
// `mock.module()` mutates a process-global module registry, so this mock
// shadows the real module for every test file that runs in the same Bun
// process. The CI runner (`bun run test:ci` → `scripts/run-tests.ts`)
// isolates each file in its own subprocess. A naive `bun test src/...`
// over a directory will pollute later suites — every export of
// `messages.ts` is stubbed below so cross-loaded tests fail with a
// pointer back here rather than an opaque "Export not found".
const moduleScopeStub = (name: string) => () => {
  throw new Error(
    `[use-message-reconciliation.test.tsx] '${name}' was called via the ` +
      `process-global mock.module shadow. Run this test file in isolation ` +
      `(\`bun test path/to/file.test.ts\`) or via \`bun run test:ci\`.`,
  );
};

mock.module("@/domains/chat/api/messages", () => ({
  fetchConversationMessages: async (_assistantId: string, _conversationId: string) => {
    fetchCallCount++;
    if (mockFetchSideEffect) mockFetchSideEffect();
    if (mockFetchError) throw mockFetchError;
    return { messages: mockFetchResult, seq: mockFetchSeq };
  },
  // Stubs for the rest of the real module's surface. Provided so dependent
  // test files that import these still get *something* under the global
  // mock shadow; calling any of them surfaces a clear error.
  pollForResponse: moduleScopeStub("pollForResponse"),
  getChatHistory: moduleScopeStub("getChatHistory"),
  uploadChatAttachment: moduleScopeStub("uploadChatAttachment"),
  postChatMessage: moduleScopeStub("postChatMessage"),
  deleteQueuedMessage: moduleScopeStub("deleteQueuedMessage"),
  mapRuntimeToolCalls: (
    toolCalls: Array<{ name: string; input?: unknown; result?: unknown; isError?: boolean }>,
    messageId: string,
  ) =>
    toolCalls.map((tc, idx) => ({
      id: `tool-history-${messageId}-${idx}`,
      name: tc.name,
      input: tc.input,
      ...(tc.result !== undefined ? { result: tc.result } : {}),
      ...(tc.isError !== undefined ? { isError: tc.isError } : {}),
    })),
  normalizeContentOrder: (raw: unknown[] | undefined) => {
    if (!raw || raw.length === 0) return undefined;
    const result: Array<{ type: string; id: string }> = [];
    for (const entry of raw) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const obj = entry as Record<string, unknown>;
        if (typeof obj.type === "string" && typeof obj.id === "string") {
          result.push({ type: obj.type, id: obj.id });
        }
      } else if (typeof entry === "string") {
        const colonIdx = entry.indexOf(":");
        if (colonIdx > 0) result.push({ type: entry.slice(0, colonIdx), id: entry.slice(colonIdx + 1) });
      }
    }
    return result.length > 0 ? result : undefined;
  },
}));

// ---------------------------------------------------------------------------
// Subject under test (imported AFTER module mocks).
// ---------------------------------------------------------------------------

import type { useMessageReconciliation } from "@/domains/chat/hooks/use-message-reconciliation";
import type { ConversationMessage } from "@vellumai/assistant-api";

import {
  makeServerMessage,
  textBody,
  wireTextBody,
} from "@/domains/chat/utils/message-test-helpers";
type HookReturn = ReturnType<typeof useMessageReconciliation>;

// ---------------------------------------------------------------------------
// Test harness — captures hook result via a callback prop.
// ---------------------------------------------------------------------------

interface HarnessProps {
  latestPageOldestTimestamp?: number | null;
  collect: (result: HookReturn) => void;
}

// Lazy-import to avoid hoisting above mock.module
let hookModule: typeof import("./use-message-reconciliation") | null = null;

function HookHarness(props: HarnessProps): null {
  if (!hookModule) throw new Error("hookModule not loaded");
  const result = hookModule.useMessageReconciliation({
    latestPageOldestTimestamp: props.latestPageOldestTimestamp ?? null,
  });
  props.collect(result);
  return null;
}

// ---------------------------------------------------------------------------
// Shared state + helpers
// ---------------------------------------------------------------------------

/** Read/write proxy for the store's `messages` field. Tests assign to
 *  `messages` before creating the harness (seeding), then read it after
 *  reconciliation to check the result. Under the hood everything flows
 *  through the store's real `setMessages` action — no custom override.
 *  A store subscription keeps this variable in sync automatically. */
let messages: DisplayMessage[] = [];
let unsubscribeMessages: (() => void) | null = null;
let onPollReconciledSpy: ReturnType<typeof mock>;



function makeMessage(
  overrides: Omit<DisplayMessage, "id"> & { id?: string },
): DisplayMessage {
  const { id, ...rest } = overrides;
  return { id: id ?? crypto.randomUUID(), ...rest };
}

function createHarness(overrides?: {
  streamContext?: { assistantId: string; conversationId: string } | null;
  streamEpoch?: number;
  activeConversationId?: string | null;
  turnState?: TurnState;
}): HookReturn {
  // Set turn state on the Zustand store before rendering
  const turnState = overrides?.turnState ?? INITIAL_TURN_STATE;
  useTurnStore.setState(turnState);
  // Spy on onPollReconciled after setState so the spy is on the current instance
  onPollReconciledSpy = mock();
  useTurnStore.setState({ onPollReconciled: onPollReconciledSpy as never });

  // Seed the conversation store with the active conversation id — the
  // hook reads it via `useConversationStore.getState().activeConversationId`.
  useConversationStore.setState({
    activeConversationId: overrides?.activeConversationId ?? "conv-1",
  });

  let captured: HookReturn | null = null;
  // Seed the store's messages field with the current test messages so the
  // hook's `setMessages` updater reads the correct `prev` value.
  useChatSessionStore.setState({ messages });

  // Subscribe to keep the local `messages` variable in sync with the store.
  // This allows existing test assertions (`expect(messages).toHaveLength(...)`)
  // to work without changes — the store's `setMessages` action updates
  // `state.messages`, and the subscription propagates it here.
  if (unsubscribeMessages) unsubscribeMessages();
  unsubscribeMessages = useChatSessionStore.subscribe((state) => {
    messages = state.messages;
  });

  useStreamStore.setState({
    streamContext: overrides?.streamContext ?? null,
    streamEpoch: overrides?.streamEpoch ?? 0,
  });

  renderToStaticMarkup(
    createElement(HookHarness, {
      collect: (result) => { captured = result; },
    }),
  );

  if (!captured) throw new Error("HookHarness did not invoke the hook");
  return captured;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  if (!hookModule) {
    hookModule = await import("./use-message-reconciliation");
  }
  // Clean up any previous store subscription.
  if (unsubscribeMessages) {
    unsubscribeMessages();
    unsubscribeMessages = null;
  }
  messages = [];
  mockFetchResult = [];
  mockFetchSeq = null;
  mockFetchError = null;
  mockFetchSideEffect = null;
  fetchCallCount = 0;
  // The local seq frontier is module-global; clear it so a frontier seeded
  // by one test never leaks into the next.
  __resetLocalSeqForTesting();
  // Zustand stores survive across tests in the same Bun process; reset
  // the conversation-list state so each test sees a clean slate.
  useConversationStore.setState({
    processingConversationIds: new Set(),
    processingSnapshots: new Map(),
    attentionConversationIds: new Set(),
    activeConversationId: null,
    editingConversationId: null,
  });
  // Reset the chat session store to initial state.
  useChatSessionStore.setState({
    messages: [],
    error: null,
    isLoadingHistory: true,
    streamingMessageIds: new Set(),
    pendingQueuedMessageIds: [],
    requestIdToMessageId: new Map(),
    pendingLocalDeletions: new Set(),
    confirmationToolCallMap: new Map(),
    expandedToolCallIds: new Set(),
  });
});

// ---------------------------------------------------------------------------
// reconcileFromServer
// ---------------------------------------------------------------------------

describe("reconcileFromServer", () => {
  test("returns false for empty server messages", () => {
    const { reconcileFromServer } = createHarness();
    expect(reconcileFromServer([], "conv-1", null)).toBe(false);
  });

  test("returns true when messages change", () => {
    messages = [makeMessage({ id: "m1", role: "user", ...textBody("Hello") })];
    const { reconcileFromServer } = createHarness();
    const serverMessages: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("World") }),
    ];
    expect(reconcileFromServer(serverMessages, "conv-1", null)).toBe(true);
  });

  test("completes without error when server messages match local (smoke test)", () => {
    const msg = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    messages = [msg];
    const { reconcileFromServer } = createHarness();
    const serverMessages: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
    ];
    // The seq snapshot reconcile may rebuild messages from server data, so
    // the array reference can change even when rendered content is
    // identical. This is a smoke test that the round-trip completes without
    // error.
    const result = reconcileFromServer(serverMessages, "conv-1", null);
    expect(typeof result).toBe("boolean");
  });

  test("updates messages state with reconciled result", () => {
    messages = [makeMessage({ id: "m1", role: "user", ...textBody("Hello") })];
    const { reconcileFromServer } = createHarness();
    const serverMessages: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Response") }),
    ];
    reconcileFromServer(serverMessages, "conv-1", null);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ id: "m2", role: "assistant", ...textBody("Response") });
  });

  test("surfaces on server messages are preserved in reconciled messages", () => {
    messages = [makeMessage({ id: "m1", role: "user", ...textBody("Hello") })];
    const { reconcileFromServer } = createHarness();
    const serverMessages: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({
        id: "m2",
        role: "assistant",
        ...wireTextBody("Here is a form"),
        surfaces: [{ surfaceId: "surf-1", surfaceType: "form", data: { field: "value" } }],
      }),
    ];
    reconcileFromServer(serverMessages, "conv-1", null);
    // Surfaces now live directly on messages, not in a separate Map
    const assistantMsg = messages.find((m) => m.id === "m2");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.surfaces).toHaveLength(1);
    expect(assistantMsg!.surfaces![0]!.surfaceId).toBe("surf-1");
  });
});

// ---------------------------------------------------------------------------
// reconcileActiveConversation
// ---------------------------------------------------------------------------

describe("reconcileActiveConversation", () => {
  test("returns no-change when streamContext is null", async () => {
    const { reconcileActiveConversation } = createHarness({ streamContext: null });
    const result = await reconcileActiveConversation();
    expect(result).toEqual({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    });
    expect(fetchCallCount).toBe(0);
  });

  test("fetches messages and reconciles when context exists", async () => {
    messages = [makeMessage({ id: "m1", role: "user", ...textBody("Hello") })];
    mockFetchResult = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Response") }),
    ];
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
    });
    const result = await reconcileActiveConversation();
    expect(fetchCallCount).toBe(1);
    expect(result.changed).toBe(true);
    // Server has [user, assistant], local had [user]: one new
    // assistant message was added.
    expect(result.messagesAdded).toBe(1);
    expect(result.assistantProgress).toBe(true);
    expect(messages).toHaveLength(2);
  });

  test("returns false when conversation key changed during fetch (stale guard)", async () => {
    messages = [makeMessage({ id: "m1", role: "user", ...textBody("Hello") })];
    mockFetchResult = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Response") }),
    ];
    // streamContext says "conv-1" but activeConversationId is now "conv-2"
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-2",
    });
    const result = await reconcileActiveConversation();
    expect(fetchCallCount).toBe(1);
    expect(result.changed).toBe(false);
    expect(result.messagesAdded).toBe(0);
    // Messages should NOT have been updated
    expect(messages).toHaveLength(1);
  });

  test("calls onPollReconciled when messages changed and turn is stuck sending", async () => {
    messages = [makeMessage({ id: "m1", role: "user", ...textBody("Hello") })];
    mockFetchResult = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Response") }),
    ];
    const stuckTurnState: TurnState = {
      phase: "thinking",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: "turn-42",
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: stuckTurnState,
    });
    await reconcileActiveConversation();
    expect(onPollReconciledSpy).toHaveBeenCalledTimes(1);
    expect(onPollReconciledSpy).toHaveBeenCalledWith("turn-42");
  });

  test("clears active conversation processing key on silent-stall rescue", async () => {
    // The send pathway adds the active conversation id to
    // `processingConversationIds`; the SSE terminal-event handlers
    // (`handleAssistantActivityState(idle)`, `handleMessageComplete`,
    // `handleGenerationCancelled`, error handlers) are the only sites that
    // clear it for the active conversation — the graduation effect in
    // `useAttentionTracking` explicitly skips the active conversation. When
    // SSE drops the terminal event, the silent-stall rescue here is the
    // last line of defense. If it only clears the turn-store but not the
    // processing key, `canStopGeneration` and the sidebar processing dot
    // stay "true" even though the assistant message has already rendered.
    messages = [makeMessage({ id: "m1", role: "user", ...textBody("Hello") })];
    mockFetchResult = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Response") }),
    ];
    useConversationStore.setState({
      processingConversationIds: new Set(["conv-1"]),
    });
    const stuckTurnState: TurnState = {
      phase: "thinking",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: "turn-42",
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: stuckTurnState,
    });

    await reconcileActiveConversation();

    expect(onPollReconciledSpy).toHaveBeenCalledTimes(1);
    expect(
      useConversationStore.getState().processingConversationIds.has("conv-1"),
    ).toBe(false);
  });

  test("does NOT touch processing key during a healthy mid-stream sync reconcile", async () => {
    // Regression guard for the silent-stall rescue: the processing-key
    // clear must only fire on the rescue path. During a healthy mid-stream
    // reconcile (no content drift, server matches local), the rescue
    // does not fire, and the processing key must stay set — clearing
    // it would prematurely hide the sidebar processing dot while the
    // turn is still legitimately running.
    const msg = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const assistantMsg = makeMessage({
      id: "m2",
      role: "assistant",
      ...textBody("Working on it..."),
    });
    messages = [msg, assistantMsg];
    mockFetchResult = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Working on it...") }),
    ];
    useConversationStore.setState({
      processingConversationIds: new Set(["conv-1"]),
    });
    // AND the live stream has advanced this conversation's local seq (L)
    // past the debounced snapshot's watermark (S): the persisted snapshot
    // lags the rendered stream, which is the steady state mid-turn. Under
    // the monotonic merge `L > S` keeps the live local rows, so the
    // reconcile is a no-op and the rescue must not fire.
    mockFetchSeq = 5;
    recordLocalSeq("conv-1", 10);
    const liveStreamingState: TurnState = {
      phase: "streaming",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: "turn-42",
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: liveStreamingState,
    });

    await reconcileActiveConversation();

    expect(onPollReconciledSpy).not.toHaveBeenCalled();
    expect(
      useConversationStore.getState().processingConversationIds.has("conv-1"),
    ).toBe(true);
  });

  test("does NOT call onPollReconciled when turnId is null", async () => {
    messages = [makeMessage({ id: "m1", role: "user", ...textBody("Hello") })];
    mockFetchResult = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Response") }),
    ];
    const noTurnIdState: TurnState = {
      phase: "thinking",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: null,
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: noTurnIdState,
    });
    await reconcileActiveConversation();
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });

  test("does NOT call onPollReconciled when turn is already idle", async () => {
    messages = [makeMessage({ id: "m1", role: "user", ...textBody("Hello") })];
    mockFetchResult = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Response") }),
    ];
    const idleTurnState: TurnState = {
      phase: "idle",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: "turn-42",
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: idleTurnState,
    });
    await reconcileActiveConversation();
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });

  test("does NOT call onPollReconciled when server returns empty messages", async () => {
    // Empty server response — the turn may be legitimately starting up,
    // so we don't treat it as evidence the turn should be idle.
    messages = [];
    mockFetchResult = [];
    const stuckTurnState: TurnState = {
      phase: "thinking",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: "turn-42",
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: stuckTurnState,
    });
    await reconcileActiveConversation();
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });

  test("calls onPollReconciled when local is streaming but server has longer assistant content", async () => {
    // Real silent-stall fingerprint: SSE delivered partial text, then
    // message_complete was lost (e.g. backgrounded tab). The server's
    // persisted view has the full final content; local is still marked
    // streaming with the partial text. Reconcile sees the content drift
    // → changed = true → assistantProgress = true → rescue fires.
    //
    // Note: this test deliberately uses a CONTENT MISMATCH between local
    // and server. A live row that merely trails the latest user message is
    // not a stuckness signal on its own (it's indistinguishable from a
    // healthy mid-stream sync reconcile). The rescue requires positive
    // structural evidence — the server holding longer assistant content
    // than the client ever rendered.
    const msg = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const assistantMsg = makeMessage({
      id: "m2",
      role: "assistant",
      ...textBody("Response in"),
    });
    messages = [msg, assistantMsg];
    mockFetchResult = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Response in progress... and now done.") }),
    ];
    const stuckTurnState: TurnState = {
      phase: "streaming",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: "turn-42",
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: stuckTurnState,
    });
    await reconcileActiveConversation();
    expect(onPollReconciledSpy).toHaveBeenCalledTimes(1);
    expect(onPollReconciledSpy).toHaveBeenCalledWith("turn-42");
  });

  test("does NOT call onPollReconciled during a healthy mid-stream sync reconcile", async () => {
    // Regression guard for the bubble-split fix (PR #31866 / codex P1):
    // when a sync-tag reconcile lands during a healthy live stream, the
    // live row's content matches what local already has (server has caught
    // up to the latest delta, no newer content yet). This must NOT fire
    // the silent-stall rescue — doing so would force-idle the turn and
    // force-complete every running tool call, mid-stream.
    const msg = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const assistantMsg = makeMessage({
      id: "m2",
      role: "assistant",
      ...textBody("Working on it..."),
    });
    messages = [msg, assistantMsg];
    mockFetchResult = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Working on it...") }),
    ];
    // AND the live stream has advanced the local seq (L) past the debounced
    // snapshot watermark (S): the snapshot lags the rendered stream, so the
    // monotonic merge keeps the live local rows and the reconcile is a
    // no-op. The rescue must not fire mid-stream.
    mockFetchSeq = 5;
    recordLocalSeq("conv-1", 10);
    const liveStreamingState: TurnState = {
      phase: "streaming",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: "turn-42",
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: liveStreamingState,
    });
    await reconcileActiveConversation();
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });

  test("does NOT call onPollReconciled when messages match during thinking phase", async () => {
    // User backgrounds during "thinking" (before first delta). Server
    // has the same messages from prior history. changed = false, so
    // no premature idle dispatch — the turn is legitimately active.
    const msg = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    messages = [msg];
    mockFetchResult = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
    ];
    const thinkingTurnState: TurnState = {
      phase: "thinking",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: "turn-42",
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: thinkingTurnState,
    });
    await reconcileActiveConversation();
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });

  test("does NOT call onPollReconciled when only optimistic user message id changes", async () => {
    messages = [
      makeMessage({ id: "m-old-a", role: "assistant", ...textBody("Prior response") }),
      // Optimistic user rows are explicitly flagged so the snapshot
      // reconcile's optimistic echo-swap can adopt the server-assigned
      // row's id in their place.
      makeMessage({ role: "user", ...textBody("Continue the story"), isOptimistic: true }),
    ];
    mockFetchResult = [
      makeServerMessage({ id: "m-old-a", role: "assistant", ...wireTextBody("Prior response") }),
      makeServerMessage({ id: "m-user-1", role: "user", ...wireTextBody("Continue the story") }),
    ];
    const thinkingTurnState: TurnState = {
      phase: "thinking",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: "turn-42",
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: thinkingTurnState,
    });
    const result = await reconcileActiveConversation();
    expect(result.changed).toBe(true);
    // Optimistic user message gets its server-assigned id, but no
    // new row was added — length is unchanged.
    expect(result.messagesAdded).toBe(0);
    expect(messages[1]).toMatchObject({ id: "m-user-1", role: "user" });
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });

  test("does NOT call onPollReconciled when only older assistant history changes", async () => {
    messages = [
      makeMessage({ id: "m-user-old", role: "user", ...textBody("Start the story") }),
      makeMessage({ id: "m-old-a", role: "assistant", ...textBody("Prior response") }),
      makeMessage({ role: "user", ...textBody("Continue the story") }),
    ];
    mockFetchResult = [
      makeServerMessage({ id: "m-user-old", role: "user", ...wireTextBody("Start the story") }),
      makeServerMessage({ id: "m-old-a", role: "assistant", ...wireTextBody("Prior response with more detail") }),
      makeServerMessage({ id: "m-user-1", role: "user", ...wireTextBody("Continue the story") }),
    ];
    const thinkingTurnState: TurnState = {
      phase: "thinking",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: "turn-42",
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: thinkingTurnState,
    });
    const result = await reconcileActiveConversation();
    expect(result.changed).toBe(true);
    expect(messages[1]).toMatchObject({
      id: "m-old-a",
      role: "assistant",
      ...textBody("Prior response with more detail"),
    });
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });

  test("bails out when epoch changes during fetch", async () => {
    // Simulate the page going hidden while the fetch is in-flight:
    // the hidden handler bumps the epoch, so this reconciliation is stale.
    messages = [makeMessage({ id: "m1", role: "user", ...textBody("Hello") })];
    mockFetchResult = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Response") }),
    ];
    mockFetchSideEffect = () => { useStreamStore.setState({ streamEpoch: 2 }); };
    const stuckTurnState: TurnState = {
      phase: "streaming",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: "turn-42",
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      streamEpoch: 1,
      activeConversationId: "conv-1",
      turnState: stuckTurnState,
    });
    const result = await reconcileActiveConversation();
    expect(result.changed).toBe(false);
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });

  test("does NOT call onPollReconciled when activeTurnId changed during fetch", async () => {
    // User starts a new turn while the visibility reconciliation fetch
    // is in-flight. The new turn has a different activeTurnId, so
    // wasStuck is false (turnId mismatch).
    messages = [makeMessage({ id: "m1", role: "user", ...textBody("Hello") })];
    mockFetchResult = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Response") }),
    ];
    // During fetch, a new turn starts with a different turnId
    mockFetchSideEffect = () => {
      useTurnStore.setState({
        phase: "thinking",
        pendingQueuedCount: 0,
        activeToolCallCount: 0,
        activeTurnId: "turn-new",
        lastTerminalReason: null,
        statusText: null,
        onPollReconciled: mock() as never,
      });
      onPollReconciledSpy = useTurnStore.getState().onPollReconciled as ReturnType<typeof mock>;
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: {
        phase: "streaming",
        pendingQueuedCount: 0,
        activeToolCallCount: 0,
        activeTurnId: "turn-old",
        lastTerminalReason: null,
        statusText: null,
        liveWebActivity: {},
        autoRoutedProfileLabel: null,
      },
    });
    await reconcileActiveConversation();
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });

  test("does NOT fire the silent-stall rescue when the turn is sending and the server returns empty", async () => {
    // Empty server response + active turn → no POLL_RECONCILED, because we
    // treat empty responses as "server hasn't caught up yet."
    // reconcileFromServer bails early (returns false), so there is no
    // assistant progress to rescue on.
    messages = [
      makeMessage({ id: "m1", role: "user", ...textBody("Hello") }),
      makeMessage({ id: "m2", role: "assistant", ...textBody("Response") }),
    ];
    mockFetchResult = [];
    const streamingTurnState: TurnState = {
      phase: "streaming",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: "turn-42",
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: streamingTurnState,
    });
    await reconcileActiveConversation();
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });

  test("rejects on fetch error so callers can distinguish failure from no-change", async () => {
    mockFetchError = new Error("Network error");
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
    });
    await expect(reconcileActiveConversation()).rejects.toThrow("Network error");
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });

  test("calls onPollReconciled for all sending phases", async () => {
    const sendingPhases = ["queued", "thinking", "streaming", "awaiting_user_input"] as const;
    for (const phase of sendingPhases) {
      messages = [makeMessage({ id: "m1", role: "user", ...textBody("Hello") })];
      mockFetchResult = [
        makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
        makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Response") }),
      ];
      const turnState: TurnState = {
        phase,
        pendingQueuedCount: 0,
        activeToolCallCount: 0,
        activeTurnId: "turn-99",
        lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
      };
      const { reconcileActiveConversation } = createHarness({
        streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
        activeConversationId: "conv-1",
        turnState,
      });
      await reconcileActiveConversation();
      expect(onPollReconciledSpy).toHaveBeenCalledTimes(1);
      expect(onPollReconciledSpy).toHaveBeenCalledWith("turn-99");
    }
  });
});

// ---------------------------------------------------------------------------
// reconcileActiveConversation — fetch failure
// ---------------------------------------------------------------------------

describe("reconcileActiveConversation — fetch failure", () => {
  test("does NOT call onPollReconciled when fetch fails, even if turn is stuck", async () => {
    messages = [makeMessage({ id: "m1", role: "user", ...textBody("Hello") })];
    mockFetchError = new Error("network timeout");
    const turnState: TurnState = {
      phase: "streaming",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: "turn-stuck",
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState,
    });
    await expect(reconcileActiveConversation()).rejects.toThrow("network timeout");
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cancelReconciliation
// ---------------------------------------------------------------------------

describe("cancelReconciliation", () => {
  test("can be called without error when no timer is active", () => {
    const { cancelReconciliation } = createHarness();
    expect(() => cancelReconciliation()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// startReconciliationLoop
// ---------------------------------------------------------------------------

describe("startReconciliationLoop", () => {
  test("calls onPollReconciled when resume polling finds assistant progress", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers: Array<() => void> = [];

    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") {
        timers.push(callback as () => void);
      }
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout;

    try {
      messages = [makeMessage({ id: "m1", role: "user", ...textBody("Hello") })];
      mockFetchResult = [
        makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
        makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Response") }),
      ];

      const { startReconciliationLoop, cancelReconciliation } = createHarness({
        streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
        streamEpoch: 7,
        activeConversationId: "conv-1",
        turnState: {
          phase: "streaming",
          pendingQueuedCount: 0,
          activeToolCallCount: 0,
          activeTurnId: "turn-resume",
          lastTerminalReason: null,
          statusText: null,
          liveWebActivity: {},
          autoRoutedProfileLabel: null,
        },
      });

      startReconciliationLoop(7);
      expect(timers).toHaveLength(1);
      timers.shift()!();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchCallCount).toBe(1);
      expect(onPollReconciledSpy).toHaveBeenCalledTimes(1);
      expect(onPollReconciledSpy).toHaveBeenCalledWith("turn-resume");
      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({
        id: "m2",
        role: "assistant",
        ...textBody("Response"),
      });

      cancelReconciliation();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("exits via stable-count after two unchanged ticks without reaching RECONCILE_MAX_MS", async () => {
    // Regression guard: `tick()`'s caller of `reconcileFetchedMessages`
    // destructures `{ changed }` from the result object. If a future
    // refactor reverts to `const changed = reconcileFetchedMessages(...)`,
    // the truthiness check passes for any non-null object, `stableCount`
    // never increments, and the loop runs to RECONCILE_MAX_MS instead of
    // exiting after two stable polls.
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers: Array<() => void> = [];

    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") {
        timers.push(callback as () => void);
      }
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout;

    try {
      messages = [
        makeMessage({ id: "m1", role: "user", ...textBody("Hello") }),
        makeMessage({ id: "m2", role: "assistant", ...textBody("Response") }),
      ];
      mockFetchResult = [
        makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
        makeServerMessage({
          id: "m2",
          role: "assistant",
          ...wireTextBody("Response"),
        }),
      ];
      // GIVEN the local seq (L) sits above the snapshot watermark (S): each
      // poll tick applies a snapshot that lags the rendered stream, so the
      // monotonic merge keeps the local rows and every tick is unchanged.
      mockFetchSeq = 5;
      recordLocalSeq("conv-1", 10);

      const { startReconciliationLoop, cancelReconciliation } = createHarness({
        streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
        streamEpoch: 1,
        activeConversationId: "conv-1",
        turnState: INITIAL_TURN_STATE,
      });

      startReconciliationLoop(1);
      expect(timers).toHaveLength(1);

      // Tick 1: server matches local → changed=false → stableCount=1 →
      // loop schedules another tick.
      timers.shift()!();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchCallCount).toBe(1);
      expect(timers).toHaveLength(1);

      // Tick 2: still matches → changed=false → stableCount=2 →
      // RECONCILE_STABLE_COUNT reached → loop exits without scheduling.
      timers.shift()!();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchCallCount).toBe(2);
      expect(timers).toHaveLength(0);

      cancelReconciliation();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});

// ---------------------------------------------------------------------------
// reconcileActiveConversation — stale tool call cleanup
// ---------------------------------------------------------------------------

describe("reconcileActiveConversation — stale tool call cleanup", () => {
  test("force-completes stale running tool calls when turn is idle", async () => {
    messages = [
      makeMessage({ id: "m1", role: "user", ...textBody("Hello") }),
      makeMessage({
        id: "m2",
        role: "assistant",
        ...textBody(""),
        toolCalls: [
          { id: "tc-1", name: "web_search", input: {} },
        ],
      }),
    ];
    mockFetchResult = [];
    const idleTurnState: TurnState = {
      phase: "idle",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: null,
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: idleTurnState,
    });
    await reconcileActiveConversation();

    // The running tool call should be force-completed once the turn is idle.
    expect(isToolCallCompleted(messages[1]!.toolCalls![0]!)).toBe(true);
    expect(messages[1]!.toolCalls![0]!.completedAt).toBeDefined();
  });

  test("force-completes stale tool calls on a non-live assistant row", async () => {
    messages = [
      makeMessage({ id: "m1", role: "user", ...textBody("Hello") }),
      makeMessage({
        id: "m2",
        role: "assistant",
        ...textBody("partial"),
        toolCalls: [
          { id: "tc-1", name: "web_search", input: {} },
          { id: "tc-2", name: "bash", input: {}, completedAt: 1 },
        ],
      }),
    ];
    mockFetchResult = [];
    const idleTurnState: TurnState = {
      phase: "idle",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: null,
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: idleTurnState,
    });
    await reconcileActiveConversation();

    // The running tool call should be force-completed
    expect(isToolCallCompleted(messages[1]!.toolCalls![0]!)).toBe(true);
    expect(messages[1]!.toolCalls![0]!.completedAt).toBeDefined();
    // The already-completed tool call should be unchanged
    expect(isToolCallCompleted(messages[1]!.toolCalls![1]!)).toBe(true);
  });

  test("does NOT force-complete tool calls when turn is still sending", async () => {
    messages = [
      makeMessage({ id: "m1", role: "user", ...textBody("Hello") }),
      makeMessage({
        id: "m2",
        role: "assistant",
        ...textBody(""),
        toolCalls: [
          { id: "tc-1", name: "web_search", input: {} },
        ],
      }),
    ];
    mockFetchResult = [];
    const streamingTurnState: TurnState = {
      phase: "streaming",
      pendingQueuedCount: 0,
      activeToolCallCount: 0,
      activeTurnId: "turn-42",
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
      turnState: streamingTurnState,
    });
    await reconcileActiveConversation();

    // Tool call should remain running since the turn is still active
    expect(isToolCallRunning(messages[1]!.toolCalls![0]!)).toBe(true);
  });
});
