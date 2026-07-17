/**
 * Verifies that the inference-profile-change notification is persisted only
 * once the model has actually received the turn context carrying the
 * `model_profile` block — signalled by the first `message_complete` event from
 * the agent loop — rather than inline before the provider call. A turn that
 * fails or is cancelled before delivery never emits `message_complete`, so the
 * notice is re-sent on the next turn instead of being silently suppressed.
 */
import { describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";

// The finalize path indexes tool-result messages into memory; keep it inert
// (the old partial mock left memory undefined/disabled) so no real embedding
// backend is touched.
setConfig("memory", { enabled: false, v2: { enabled: false } });

const setLastNotifiedInferenceProfile = mock(
  (_conversationId: string, _profileKey: string) => {},
);

mock.module("../../persistence/conversation-crud.js", () => ({
  deleteMessageById: () => {},
  getConversation: () => null,
  getMessageById: () => null,
  messageMetadataSchema: { safeParse: () => ({ success: false }) },
  provenanceFromTrustContext: () => ({}),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
  setConversationHistoryStrippedAt: () => {},
  setLastNotifiedInferenceProfile,
  updateMessageContent: () => {},
}));

mock.module("../../persistence/llm-request-log-store.js", () => ({
  backfillMessageIdOnLogs: () => {},
  buildProviderErrorResponsePayload: () => ({}),
  recordRequestLog: () => {},
  setAgentLoopExitReasonOnLatestLog: () => {},
}));

mock.module("../../plugins/defaults/memory/memory-recall-log-store.js", () => ({
  backfillMemoryRecallLogMessageId: () => {},
}));

mock.module(
  "../../plugins/defaults/memory/memory-v2-activation-log-store.js",
  () => ({
    backfillMemoryV2ActivationMessageId: () => {},
  }),
);

// ── Imports (after mocks) ────────────────────────────────────────────────────
import type { AgentEvent } from "../../agent/loop.js";
import type { Message } from "../../providers/types.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  dispatchAgentEvent,
} from "../conversation-agent-loop-handlers.js";

const CONVERSATION_ID = "conv-profile-notify";
const PROFILE_KEY = "quality-optimized";

function makeDeps(): EventHandlerDeps {
  return {
    ctx: {
      conversationId: CONVERSATION_ID,
      provider: { name: "mock-provider" },
      currentTurnSurfaces: [],
      trustContext: undefined,
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: () => {},
    reqId: "req-profile-notify",
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
    applyCompaction: async () => {},
  } as EventHandlerDeps;
}

function messageCompleteEvent(): Extract<
  AgentEvent,
  { type: "message_complete" }
> {
  const message: Message = {
    role: "assistant",
    content: [{ type: "text", text: "response" }],
  };
  return { type: "message_complete", message };
}

// A reserved assistant row id is the precondition `handleMessageComplete`
// asserts before finalizing; the row reservation itself is exercised elsewhere.
function readyState(): EventHandlerState {
  const state = createEventHandlerState();
  state.lastAssistantMessageId = "assistant-row-1";
  return state;
}

describe("inference-profile-change notification persistence", () => {
  test("persists on the first message_complete and clears the pending slot", async () => {
    setLastNotifiedInferenceProfile.mockClear();
    const state = readyState();
    state.pendingNotifiedInferenceProfile = PROFILE_KEY;

    await dispatchAgentEvent(state, makeDeps(), messageCompleteEvent());

    expect(setLastNotifiedInferenceProfile).toHaveBeenCalledTimes(1);
    expect(setLastNotifiedInferenceProfile).toHaveBeenCalledWith(
      CONVERSATION_ID,
      PROFILE_KEY,
    );
    expect(state.pendingNotifiedInferenceProfile).toBeNull();
  });

  test("does not persist when the turn carries no profile-change notice", async () => {
    setLastNotifiedInferenceProfile.mockClear();
    const state = readyState();

    await dispatchAgentEvent(state, makeDeps(), messageCompleteEvent());

    expect(setLastNotifiedInferenceProfile).not.toHaveBeenCalled();
  });

  test("persists exactly once across a multi-call turn", async () => {
    setLastNotifiedInferenceProfile.mockClear();
    const state = readyState();
    state.pendingNotifiedInferenceProfile = PROFILE_KEY;
    const deps = makeDeps();

    await dispatchAgentEvent(state, deps, messageCompleteEvent());
    await dispatchAgentEvent(state, deps, messageCompleteEvent());

    expect(setLastNotifiedInferenceProfile).toHaveBeenCalledTimes(1);
  });
});
