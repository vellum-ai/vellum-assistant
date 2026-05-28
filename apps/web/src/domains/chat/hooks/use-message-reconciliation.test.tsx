/**
 * Tests for `useMessageReconciliation`.
 *
 * Since the workspace doesn't ship `@testing-library/react`, we follow the
 * project convention of rendering a tiny component via `renderToStaticMarkup`
 * to capture the hook's return value.  The hook accepts external refs so the
 * test harness controls all mutable state.
 *
 * Key behaviors under test:
 * - `reconcileFromServer`: delegates to `reconcileMessages`,
 *   reports changed vs unchanged.
 * - `reconcileActiveConversation`: orchestrates fetch, reconciliation,
 *   turn-state dispatch (`POLL_RECONCILED`), and stale-`isStreaming` cleanup.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import { INITIAL_TURN_STATE, type TurnState, useTurnStore } from "@/stores/turn-store";
import { useConversationStore } from "@/stores/conversation-store";

// ---------------------------------------------------------------------------
// Mocks — module mocks MUST come before importing the subject under test.
// ---------------------------------------------------------------------------

let mockFetchResult: RuntimeMessage[] = [];
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
    return mockFetchResult;
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
      toolName: tc.name,
      input: tc.input,
      status: tc.isError ? "error" : tc.result === undefined ? "running" : "completed",
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
  normalizeTextSegments: (raw: unknown[] | undefined) => {
    if (!raw || raw.length === 0) return undefined;
    const result: Array<{ type: string; content: string }> = [];
    for (const entry of raw) {
      if (typeof entry === "string") {
        result.push({ type: "text", content: entry });
      } else if (entry && typeof entry === "object") {
        const obj = entry as Record<string, unknown>;
        if (typeof obj.content === "string") {
          result.push({
            type: typeof obj.type === "string" ? obj.type : "text",
            content: obj.content,
          });
        }
      }
    }
    return result.length > 0 ? result : undefined;
  },
}));

// ---------------------------------------------------------------------------
// Subject under test (imported AFTER module mocks).
// ---------------------------------------------------------------------------

import type { useMessageReconciliation } from "@/domains/chat/hooks/use-message-reconciliation";
import type { RuntimeMessage } from "@/domains/chat/api/messages";

type HookReturn = ReturnType<typeof useMessageReconciliation>;

// ---------------------------------------------------------------------------
// Test harness — captures hook result via a callback prop.
// ---------------------------------------------------------------------------

interface HarnessProps {
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  streamContextRef: RefObject<{ assistantId: string; conversationId: string } | null>;
  streamEpochRef: RefObject<number>;
  initialPageOldestTsRef?: RefObject<number | null>;
  collect: (result: HookReturn) => void;
}

// Lazy-import to avoid hoisting above mock.module
let hookModule: typeof import("./use-message-reconciliation") | null = null;

function HookHarness(props: HarnessProps): null {
  if (!hookModule) throw new Error("hookModule not loaded");
  const result = hookModule.useMessageReconciliation({
    setMessages: props.setMessages,
    streamContextRef: props.streamContextRef,
    streamEpochRef: props.streamEpochRef,
    initialPageOldestTsRef: props.initialPageOldestTsRef ?? makeRef(null),
  });
  props.collect(result);
  return null;
}

// ---------------------------------------------------------------------------
// Shared state + helpers
// ---------------------------------------------------------------------------

let messages: DisplayMessage[] = [];
let onPollReconciledSpy: ReturnType<typeof mock>;

function makeRef<T>(value: T): RefObject<T> {
  return { current: value };
}

function makeMessage(
  overrides: Omit<DisplayMessage, "id"> & { id?: string },
): DisplayMessage {
  const { id, ...rest } = overrides;
  return { id: id ?? crypto.randomUUID(), ...rest };
}

function createHarness(overrides?: {
  streamContext?: { assistantId: string; conversationId: string } | null;
  streamEpoch?: number;
  streamEpochRef?: RefObject<number>;
  activeConversationId?: string | null;
  turnState?: TurnState;
}): HookReturn {
  const setMessages: Dispatch<SetStateAction<DisplayMessage[]>> = (updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  };

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
  renderToStaticMarkup(
    createElement(HookHarness, {
      setMessages,
      streamContextRef: makeRef(overrides?.streamContext ?? null),
      streamEpochRef: overrides?.streamEpochRef ?? makeRef(overrides?.streamEpoch ?? 0),
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
  messages = [];
  mockFetchResult = [];
  mockFetchError = null;
  mockFetchSideEffect = null;
  fetchCallCount = 0;
  // Zustand stores survive across tests in the same Bun process; reset
  // the conversation-list state so each test sees a clean slate.
  useConversationStore.setState({
    processingConversationIds: new Set(),
    processingSnapshots: new Map(),
    attentionConversationIds: new Set(),
    activeConversationId: null,
    editingConversationId: null,
  });
});

// ---------------------------------------------------------------------------
// reconcileFromServer
// ---------------------------------------------------------------------------

describe("reconcileFromServer", () => {
  test("returns false for empty server messages", () => {
    const { reconcileFromServer } = createHarness();
    expect(reconcileFromServer([])).toBe(false);
  });

  test("returns true when messages change", () => {
    messages = [makeMessage({ id: "m1", role: "user", content: "Hello" })];
    const { reconcileFromServer } = createHarness();
    const serverMessages: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "World" },
    ];
    expect(reconcileFromServer(serverMessages)).toBe(true);
  });

  test("completes without error when server messages match local (smoke test)", () => {
    const msg = makeMessage({ id: "m1", role: "user", content: "Hello" });
    messages = [msg];
    const { reconcileFromServer } = createHarness();
    const serverMessages: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
    ];
    // reconcileMessages rebuilds messages from server data, so the array
    // reference changes even when content is identical. This is a smoke
    // test that the round-trip completes without error.
    const result = reconcileFromServer(serverMessages);
    expect(typeof result).toBe("boolean");
  });

  test("updates messages state with reconciled result", () => {
    messages = [makeMessage({ id: "m1", role: "user", content: "Hello" })];
    const { reconcileFromServer } = createHarness();
    const serverMessages: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Response" },
    ];
    reconcileFromServer(serverMessages);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ id: "m2", role: "assistant", content: "Response" });
  });

  test("surfaces on server messages are preserved in reconciled messages", () => {
    messages = [makeMessage({ id: "m1", role: "user", content: "Hello" })];
    const { reconcileFromServer } = createHarness();
    const serverMessages: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      {
        id: "m2",
        role: "assistant",
        content: "Here is a form",
        surfaces: [{ surfaceId: "surf-1", surfaceType: "form", data: { field: "value" } }],
      },
    ];
    reconcileFromServer(serverMessages);
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
    messages = [makeMessage({ id: "m1", role: "user", content: "Hello" })];
    mockFetchResult = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Response" },
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
    messages = [makeMessage({ id: "m1", role: "user", content: "Hello" })];
    mockFetchResult = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Response" },
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
    messages = [makeMessage({ id: "m1", role: "user", content: "Hello" })];
    mockFetchResult = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Response" },
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
    messages = [makeMessage({ id: "m1", role: "user", content: "Hello" })];
    mockFetchResult = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Response" },
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
    const msg = makeMessage({ id: "m1", role: "user", content: "Hello" });
    const assistantMsg = makeMessage({
      id: "m2",
      role: "assistant",
      content: "Working on it...",
      isStreaming: true,
    });
    messages = [msg, assistantMsg];
    mockFetchResult = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Working on it..." },
    ];
    useConversationStore.setState({
      processingConversationIds: new Set(["conv-1"]),
    });
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
    messages = [makeMessage({ id: "m1", role: "user", content: "Hello" })];
    mockFetchResult = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Response" },
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
    messages = [makeMessage({ id: "m1", role: "user", content: "Hello" })];
    mockFetchResult = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Response" },
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
    // and server, not just a stale `isStreaming: true` flag. With the
    // fix that preserves client-owned `isStreaming` across reconcile,
    // matching-content + isStreaming alone is no longer a stuckness
    // signal (it's indistinguishable from a healthy mid-stream sync
    // reconcile). The rescue requires positive structural evidence.
    const msg = makeMessage({ id: "m1", role: "user", content: "Hello" });
    const assistantMsg = makeMessage({
      id: "m2",
      role: "assistant",
      content: "Response in",
      isStreaming: true,
    });
    messages = [msg, assistantMsg];
    mockFetchResult = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Response in progress... and now done." },
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
    // local row is `isStreaming: true` and the server snapshot matches
    // what local already has (server has caught up to the latest delta,
    // no newer content yet). This must NOT fire the silent-stall rescue
    // — doing so would force-idle the turn, clear isStreaming, and
    // force-complete every running tool call, mid-stream.
    const msg = makeMessage({ id: "m1", role: "user", content: "Hello" });
    const assistantMsg = makeMessage({
      id: "m2",
      role: "assistant",
      content: "Working on it...",
      isStreaming: true,
    });
    messages = [msg, assistantMsg];
    mockFetchResult = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Working on it..." },
    ];
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
    const msg = makeMessage({ id: "m1", role: "user", content: "Hello" });
    messages = [msg];
    mockFetchResult = [
      { id: "m1", role: "user", content: "Hello" },
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
      makeMessage({ id: "m-old-a", role: "assistant", content: "Prior response" }),
      // Optimistic user rows are explicitly flagged so the tail
      // content-match block in reconcileMessages can drop them in favor
      // of the server-assigned row.
      makeMessage({ role: "user", content: "Continue the story", isOptimistic: true }),
    ];
    mockFetchResult = [
      { id: "m-old-a", role: "assistant", content: "Prior response" },
      { id: "m-user-1", role: "user", content: "Continue the story" },
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
      makeMessage({ id: "m-user-old", role: "user", content: "Start the story" }),
      makeMessage({ id: "m-old-a", role: "assistant", content: "Prior response" }),
      makeMessage({ role: "user", content: "Continue the story" }),
    ];
    mockFetchResult = [
      { id: "m-user-old", role: "user", content: "Start the story" },
      { id: "m-old-a", role: "assistant", content: "Prior response with more detail" },
      { id: "m-user-1", role: "user", content: "Continue the story" },
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
      content: "Prior response with more detail",
    });
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });

  test("bails out when epoch changes during fetch", async () => {
    // Simulate the page going hidden while the fetch is in-flight:
    // the hidden handler bumps the epoch, so this reconciliation is stale.
    const epochRef = makeRef(1);
    messages = [makeMessage({ id: "m1", role: "user", content: "Hello" })];
    mockFetchResult = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Response" },
    ];
    mockFetchSideEffect = () => { epochRef.current = 2; };
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
      streamEpochRef: epochRef,
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
    messages = [makeMessage({ id: "m1", role: "user", content: "Hello" })];
    mockFetchResult = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Response" },
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

  test("clears stale isStreaming flags when turn is idle and fetch returns empty", async () => {
    // When the server returns no messages, reconcileFromServer bails early
    // (returns false) and does NOT update the messages array. The local
    // messages — including their isStreaming flags — survive unchanged.
    // The stale-cleanup branch then detects and clears those flags.
    messages = [
      makeMessage({ id: "m1", role: "user", content: "Hello" }),
      makeMessage({ id: "m2", role: "assistant", content: "Response", isStreaming: true }),
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
    const result = await reconcileActiveConversation();
    expect(result.changed).toBe(false);
    // The cleanup branch should have cleared the stale isStreaming flag
    const streamingMessages = messages.filter((m) => m.isStreaming);
    expect(streamingMessages).toHaveLength(0);
    expect(messages[1]!.isStreaming).toBe(false);
  });

  test("does NOT clear isStreaming when turn is sending and server returns empty", async () => {
    // Empty server response + active turn → neither POLL_RECONCILED nor
    // isStreaming cleanup fires, because we treat empty responses as
    // "server hasn't caught up yet."
    messages = [
      makeMessage({ id: "m1", role: "user", content: "Hello" }),
      makeMessage({ id: "m2", role: "assistant", content: "Response", isStreaming: true }),
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
    expect(messages[1]!.isStreaming).toBe(true);
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });

  test("returns no-change on fetch error", async () => {
    mockFetchError = new Error("Network error");
    const { reconcileActiveConversation } = createHarness({
      streamContext: { assistantId: "asst-1", conversationId: "conv-1" },
      activeConversationId: "conv-1",
    });
    const result = await reconcileActiveConversation();
    expect(result).toEqual({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    });
    expect(onPollReconciledSpy).not.toHaveBeenCalled();
  });

  test("calls onPollReconciled for all sending phases", async () => {
    const sendingPhases = ["queued", "thinking", "streaming", "awaiting_user_input"] as const;
    for (const phase of sendingPhases) {
      messages = [makeMessage({ id: "m1", role: "user", content: "Hello" })];
      mockFetchResult = [
        { id: "m1", role: "user", content: "Hello" },
        { id: "m2", role: "assistant", content: "Response" },
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
    messages = [makeMessage({ id: "m1", role: "user", content: "Hello" })];
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
    const result = await reconcileActiveConversation();
    expect(result.changed).toBe(false);
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
      messages = [makeMessage({ id: "m1", role: "user", content: "Hello" })];
      mockFetchResult = [
        { id: "m1", role: "user", content: "Hello" },
        { id: "m2", role: "assistant", content: "Response" },
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
        content: "Response",
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
      const baseline: RuntimeMessage[] = [
        { id: "m1", role: "user", content: "Hello" },
        { id: "m2", role: "assistant", content: "Response" },
      ];
      messages = baseline.map((m) =>
        makeMessage({ id: m.id, role: m.role, content: m.content }),
      );
      mockFetchResult = baseline;

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
      makeMessage({ id: "m1", role: "user", content: "Hello" }),
      makeMessage({
        id: "m2",
        role: "assistant",
        content: "",
        isStreaming: true,
        toolCalls: [
          { id: "tc-1", toolName: "web_search", input: {}, status: "running" as const },
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

    // Both isStreaming and running tool calls should be cleared
    expect(messages[1]!.isStreaming).toBe(false);
    expect(messages[1]!.toolCalls![0]!.status).toBe("completed");
    expect(messages[1]!.toolCalls![0]!.completedAt).toBeDefined();
  });

  test("force-completes stale tool calls even when isStreaming is already false", async () => {
    messages = [
      makeMessage({ id: "m1", role: "user", content: "Hello" }),
      makeMessage({
        id: "m2",
        role: "assistant",
        content: "partial",
        isStreaming: false,
        toolCalls: [
          { id: "tc-1", toolName: "web_search", input: {}, status: "running" as const },
          { id: "tc-2", toolName: "bash", input: {}, status: "completed" as const },
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
    expect(messages[1]!.toolCalls![0]!.status).toBe("completed");
    expect(messages[1]!.toolCalls![0]!.completedAt).toBeDefined();
    // The already-completed tool call should be unchanged
    expect(messages[1]!.toolCalls![1]!.status).toBe("completed");
  });

  test("does NOT force-complete tool calls when turn is still sending", async () => {
    messages = [
      makeMessage({ id: "m1", role: "user", content: "Hello" }),
      makeMessage({
        id: "m2",
        role: "assistant",
        content: "",
        isStreaming: true,
        toolCalls: [
          { id: "tc-1", toolName: "web_search", input: {}, status: "running" as const },
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
    expect(messages[1]!.isStreaming).toBe(true);
    expect(messages[1]!.toolCalls![0]!.status).toBe("running");
  });
});
