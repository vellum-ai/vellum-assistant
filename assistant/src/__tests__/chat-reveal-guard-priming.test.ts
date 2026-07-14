/**
 * Regression tests for the live reveal-guard priming barrier (LUM-2768).
 *
 * The race: `handleToolUse` starts priming `liveRevealGuardEntries` from the
 * credential store when it records a `credentials reveal` invocation. That
 * read is asynchronous — if the reveal tool returns quickly and the store
 * read is slow, the next provider stream's text deltas would reach
 * `drainSentinelGuardedText` with an EMPTY entry list and an echoed
 * plaintext would cross SSE raw (the persisted row still redacts, but the
 * live transcript flashed the secret). The dispatcher therefore awaits any
 * in-flight priming before guarding a `text_delta` and before the
 * end-of-message guard flush.
 *
 * These tests hold the store read open deliberately, dispatch the delta
 * while priming is still pending, and assert the emitted stream text
 * carries the sentinel — never the plaintext.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Store mock: reads stay pending until the test releases them ──────────

type StoreRelease = (value: string | null) => void;
const pendingStoreReads: StoreRelease[] = [];

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: (_key: string) =>
    new Promise<string | null>((resolve) => {
      pendingStoreReads.push(resolve);
    }),
}));

// Feature flag on regardless of config contents.
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (flag: string) =>
    flag === "chat-credential-reveal",
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
}));

// ── Persistence mocks (same shape as tool-preview-lifecycle.test.ts) ─────

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getConversation: () => null,
  getMessageById: () => null,
  updateMessageContent: () => {},
  markMessageContentInflight: () => {},
  finalizeMessageContent: () => {},
  provenanceFromTrustContext: () => ({}),
  reserveMessage: () => "reserved-message-id",
  recordConversationPersistedSeq: () => {},
  getConversationPersistedSeq: () => null,
}));

mock.module("../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
}));

mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

mock.module("../plugins/defaults/memory/memory-recall-log-store.js", () => ({
  backfillMemoryRecallLogMessageId: () => {},
}));

mock.module(
  "../plugins/defaults/memory/memory-v2-activation-log-store.js",
  () => ({
    backfillMemoryV2ActivationMessageId: () => {},
  }),
);

// ── Imports (after mocks) ────────────────────────────────────────────────

import type { AgentEvent } from "../agent/loop.js";
import type { EventHandlerDeps } from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  dispatchAgentEvent,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { _resetStreamStateForTesting } from "../runtime/assistant-stream-state.js";
import { SYNTHETIC_OPENAI_PROJECT_KEY } from "./secret-fixtures.js";

function createMockDeps(collected: ServerMessage[]): EventHandlerDeps {
  return {
    ctx: {
      conversationId: "test-conversation",
      provider: { name: "anthropic" },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (msg: ServerMessage) => {
      collected.push(msg);
    },
    reqId: "test-req-id",
    isFirstMessage: false,
    shouldGenerateTitle: false,
    rlog: new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }) as unknown as EventHandlerDeps["rlog"],
    turnChannelContext: {
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
    } as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    } as EventHandlerDeps["turnInterfaceContext"],
  } as EventHandlerDeps;
}

function streamedText(events: ServerMessage[]): string {
  return events
    .filter(
      (e): e is Extract<ServerMessage, { type: "assistant_text_delta" }> =>
        (e as { type?: string }).type === "assistant_text_delta",
    )
    .map((e) => e.text)
    .join("");
}

const REVEAL_TOOL_USE = {
  type: "tool_use",
  id: "toolu_reveal",
  name: "bash",
  input: {
    command: "assistant credentials reveal --service openai --field api_key",
  },
} as Extract<AgentEvent, { type: "tool_use" }>;

beforeEach(() => {
  _resetStreamStateForTesting();
  pendingStoreReads.length = 0;
});

describe("live reveal guard priming barrier", () => {
  test("a text delta dispatched while priming is pending waits for the guard and emits the sentinel", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // tool_use records the reveal and starts priming; the store read is
    // still pending when the echo delta arrives.
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    expect(pendingStoreReads.length).toBe(1);

    const delta = dispatchAgentEvent(state, deps, {
      type: "text_delta",
      text: `Your key is ${SYNTHETIC_OPENAI_PROJECT_KEY} — rotate it.`,
    } as Extract<AgentEvent, { type: "text_delta" }>);

    // Nothing may have been emitted yet — the barrier holds the delta.
    expect(streamedText(events)).toBe("");

    // Release the slow store read, let the dispatch complete.
    pendingStoreReads[0]!(SYNTHETIC_OPENAI_PROJECT_KEY);
    await delta;

    const streamed = streamedText(events);
    expect(streamed).toContain(
      "\u3014redacted:OpenAI Project Key:openai:api_key\u3015",
    );
    expect(streamed).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
  });

  test("a failed priming read releases the barrier instead of wedging the stream", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    const delta = dispatchAgentEvent(state, deps, {
      type: "text_delta",
      text: "plain text, no secret echoed",
    } as Extract<AgentEvent, { type: "text_delta" }>);

    // Store read fails (returns nothing) — the guard stays empty but the
    // stream must not deadlock.
    pendingStoreReads[0]!(null);
    await delta;

    expect(streamedText(events)).toBe("plain text, no secret echoed");
  });

  test("steady-state deltas with no priming in flight emit synchronously", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    await dispatchAgentEvent(state, deps, {
      type: "text_delta",
      text: "hello",
    } as Extract<AgentEvent, { type: "text_delta" }>);

    expect(pendingStoreReads.length).toBe(0);
    expect(streamedText(events)).toBe("hello");
  });
});
