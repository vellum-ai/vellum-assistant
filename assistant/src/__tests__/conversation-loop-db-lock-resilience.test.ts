/**
 * Regression tests for SQLite write-contention resilience in the agent loop.
 *
 * When another writer holds the SQLite write lock long enough that
 * `busy_timeout` elapses, an in-loop content write throws `SQLITE_BUSY`
 * ("database is locked"). The turn-finalizing write at `message_complete` is on
 * `dispatchAgentEvent`'s re-throw allowlist, so before this resilience layer a
 * single transient lock aborted the whole turn and surfaced to the user as
 * "Processing failed: database is locked".
 *
 * These tests pin the two guarantees:
 *  1. A transient `SQLITE_BUSY` is retried and the row is finalized normally.
 *  2. A persistent `SQLITE_BUSY` is swallowed (logged) so the turn continues
 *     instead of throwing — a later write (this turn or the next) overwrites
 *     the dropped content.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock platform (must precede imports that read it) ─────────────────────────
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ memory: {} }),
  loadConfig: () => ({}),
}));

// `finalizeMessageContent` (the finalize seam's write) throws `SQLITE_BUSY`
// for the first `updateContentFailuresRemaining` calls, then records the
// content written.
let updateContentFailuresRemaining = 0;
const writtenContentById = new Map<string, string>();
const finalizeMessageContentMock = mock((id: string, content: string) => {
  if (updateContentFailuresRemaining > 0) {
    updateContentFailuresRemaining -= 1;
    throw Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY",
    });
  }
  writtenContentById.set(id, content);
});

// Stand-in for the `conversations.seq` column, mirroring the monotonic,
// ignore-non-positive semantics of the real `recordConversationPersistedSeq`.
const persistedSeqByConversation = new Map<string, number>();

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getConversation: () => null,
  getMessageById: () => null,
  updateMessageContent: () => {},
  markMessageContentInflight: () => {},
  finalizeMessageContent: finalizeMessageContentMock,
  provenanceFromTrustContext: () => ({}),
  reserveMessage: async (_conversationId: string, role: string) => ({
    id: role === "user" ? "tool-result-row" : "assistant-row",
  }),
  recordConversationPersistedSeq: (id: string, seq: number) => {
    if (!Number.isFinite(seq) || seq <= 0) return;
    const prev = persistedSeqByConversation.get(id);
    if (prev == null || prev < seq) persistedSeqByConversation.set(id, seq);
  },
  getConversationPersistedSeq: (id: string) =>
    persistedSeqByConversation.get(id) ?? null,
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

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import type { AgentEvent } from "../agent/loop.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  handleMessageComplete,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { getConversationPersistedSeq } from "../persistence/conversation-crud.js";

const CONVERSATION_ID = "test-session-id";

function createMockDeps(): EventHandlerDeps {
  return {
    ctx: {
      conversationId: CONVERSATION_ID,
      provider: { name: "anthropic" },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (_msg: ServerMessage) => {},
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

const MESSAGE_COMPLETE_EVENT = {
  type: "message_complete",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
} as Extract<AgentEvent, { type: "message_complete" }>;

describe("agent loop SQLite write-contention resilience", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    state = createEventHandlerState();
    // A row was reserved at llm_call_started; message_complete finalizes it.
    state.lastAssistantMessageId = "assistant-row";
    state.assistantRowAwaitingFinalization = true;
    state.lastPersistedContentSeq = 5;
    updateContentFailuresRemaining = 0;
    writtenContentById.clear();
    persistedSeqByConversation.clear();
    finalizeMessageContentMock.mockClear();
  });

  test("retries a transient SQLITE_BUSY and finalizes the assistant row", async () => {
    // GIVEN the finalize write loses the write-lock race twice before winning
    updateContentFailuresRemaining = 2;

    // WHEN message_complete drains
    await handleMessageComplete(
      state,
      createMockDeps(),
      MESSAGE_COMPLETE_EVENT,
    );

    // THEN it retried until the write committed (2 failures + 1 success) ...
    expect(finalizeMessageContentMock).toHaveBeenCalledTimes(3);
    expect(writtenContentById.get("assistant-row")).toContain("done");
    // ... the finalization completed ...
    expect(state.assistantRowAwaitingFinalization).toBe(false);
    // ... and the persisted seq advanced because the content is durable.
    expect(getConversationPersistedSeq(CONVERSATION_ID)).toBe(5);
  });

  test("swallows a persistent SQLITE_BUSY without aborting the turn", async () => {
    // GIVEN every finalize attempt loses the race (lock held past every retry)
    updateContentFailuresRemaining = Number.POSITIVE_INFINITY;

    // WHEN message_complete drains, it must resolve rather than throw — a thrown
    // SQLITE_BUSY here is on dispatchAgentEvent's re-throw allowlist and would
    // kill the turn.
    await expect(
      handleMessageComplete(state, createMockDeps(), MESSAGE_COMPLETE_EVENT),
    ).resolves.toBeUndefined();

    // THEN the write was attempted (initial try + the retries) ...
    expect(finalizeMessageContentMock.mock.calls.length).toBeGreaterThan(1);
    // ... no content landed ...
    expect(writtenContentById.has("assistant-row")).toBe(false);
    // ... and the seq was NOT advanced past content that never became durable.
    expect(getConversationPersistedSeq(CONVERSATION_ID)).toBeNull();
  });
});
