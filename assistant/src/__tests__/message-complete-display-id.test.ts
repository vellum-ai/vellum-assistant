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

  beforeEach(() => {
    addMessageCalls.length = 0;
    state = createEventHandlerState();
    state.turnStartedAt = 1_700_000_000_000;
  });

  test("tracks the merged display id separately from the final row id", async () => {
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

    expect(state.firstAssistantMessageId).toBe("mock-msg-1");
    expect(state.lastAssistantMessageId).toBe("mock-msg-1");
    expect(getClientDisplayMessageId(state)).toBe("mock-msg-1");

    state.pendingToolResults.set("toolu_1", {
      content: "ok",
      isError: false,
    });

    await handleMessageComplete(
      state,
      makeDeps(),
      makeMessageCompleteEvent([{ type: "text", text: "done" }]),
    );

    expect(addMessageCalls.map((call) => call.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect(state.firstAssistantMessageId).toBe("mock-msg-1");
    expect(state.lastAssistantMessageId).toBe("mock-msg-3");
    expect(getClientDisplayMessageId(state)).toBe("mock-msg-1");
  });
});
