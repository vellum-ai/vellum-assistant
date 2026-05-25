import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    skills: {
      entries: {},
      load: { extraDirs: [], watch: true, watchDebounceMs: 250 },
      install: { nodeManager: "npm" },
      allowBundled: null,
      remoteProviders: {
        skillssh: { enabled: true },
        clawhub: { enabled: true },
      },
      remotePolicy: {
        blockSuspicious: true,
        blockMalware: true,
        maxSkillsShRisk: "medium",
      },
    },
  }),
  loadConfig: () => ({}),
}));

interface AddMessageCall {
  conversationId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}

const addMessageCalls: AddMessageCall[] = [];

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: (
    conversationId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) => {
    addMessageCalls.push({ conversationId, role, content, metadata });
    return { id: `mock-msg-${addMessageCalls.length}` };
  },
  getConversation: () => null,
  getMessageById: () => null,
  provenanceFromTrustContext: () => ({}),
  updateMessageContent: () => {},
  updateMessageContentAndMetadata: () => {},
}));

mock.module("../memory/llm-request-log-store.js", () => ({
  backfillMessageIdOnLogs: () => {},
  recordRequestLog: () => {},
}));

mock.module("../memory/memory-recall-log-store.js", () => ({
  backfillMemoryRecallLogMessageId: () => {},
}));

mock.module("../memory/memory-v2-activation-log-store.js", () => ({
  backfillMemoryV2ActivationMessageId: () => {},
}));

mock.module("../memory/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
}));

import type { AgentEvent } from "../agent/loop.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  getClientDisplayMessageId,
  handleMessageComplete,
} from "../daemon/conversation-agent-loop-handlers.js";

const CONVERSATION_ID = "conv-display-id";

function makeDeps(): EventHandlerDeps {
  return {
    ctx: {
      conversationId: CONVERSATION_ID,
      currentTurnSurfaces: [],
      provider: { name: "anthropic" },
      traceEmitter: { emit: () => {} },
      trustContext: {
        sourceChannel: "vellum",
        trustClass: "guardian",
      },
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: () => {},
    reqId: "req-display-id",
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
      userMessageInterface: "web",
      assistantMessageInterface: "web",
    } as EventHandlerDeps["turnInterfaceContext"],
  };
}

function makeMessageCompleteEvent(
  content: Extract<
    AgentEvent,
    { type: "message_complete" }
  >["message"]["content"],
): Extract<AgentEvent, { type: "message_complete" }> {
  return {
    type: "message_complete",
    message: { role: "assistant", content },
  };
}

describe("message_complete display identity", () => {
  let state: EventHandlerState;
  const ANCHOR_ID = "anchor-id-1";

  beforeEach(() => {
    addMessageCalls.length = 0;
    // PR 2b: the anchor id is pre-allocated by the agent loop at turn start
    // and threaded into the handler state. Pass a fixed id here so the
    // assertions can refer to it by name.
    state = createEventHandlerState(ANCHOR_ID);
    state.turnStartedAt = 1_700_000_000_000;
  });

  test("anchor id is the canonical display id from turn start through tool turn", async () => {
    // First message_complete: assistant turn that emits a tool_use block.
    // PR 2b routes the FIRST message_complete of the turn through the
    // `update_content` persistence op (no addMessage call), finalizing
    // the pre-allocated anchor row in place.
    await handleMessageComplete(
      state,
      makeDeps(),
      makeMessageCompleteEvent([
        {
          type: "tool_use",
          id: "toolu_1",
          name: "bash",
          input: { command: "true" },
        },
      ]),
    );

    expect(addMessageCalls.length).toBe(0);
    expect(state.firstAssistantMessageId).toBe(ANCHOR_ID);
    expect(state.lastAssistantMessageId).toBe(ANCHOR_ID);
    expect(getClientDisplayMessageId(state)).toBe(ANCHOR_ID);

    // Tool result lands.
    state.pendingToolResults.set("toolu_1", {
      content: "ok",
      isError: false,
    });

    // Second message_complete: tool-result flush (user row) + new
    // assistant row. Since the anchor is already finalized, the assistant
    // persistence here falls through to the `add` branch and a new row
    // id is minted.
    await handleMessageComplete(
      state,
      makeDeps(),
      makeMessageCompleteEvent([{ type: "text", text: "done" }]),
    );

    expect(addMessageCalls.map((call) => call.role)).toEqual([
      "user",
      "assistant",
    ]);
    // firstAssistantMessageId was seeded with the anchor at state
    // construction and is preserved across the turn.
    expect(state.firstAssistantMessageId).toBe(ANCHOR_ID);
    // Last assistant message id moves with the most recent `add` call.
    expect(state.lastAssistantMessageId).toBe("mock-msg-2");
    // The client-visible display id stays pinned to the anchor for the
    // whole turn — that's the PR 2b contract.
    expect(getClientDisplayMessageId(state)).toBe(ANCHOR_ID);
  });
});
