import { describe, expect, mock, test } from "bun:test";

import type { AgentEvent } from "../../agent/loop.js";
import type { ServerMessage } from "../message-protocol.js";

const broadcastedMessages: ServerMessage[] = [];

mock.module("../../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (message: ServerMessage) => {
    broadcastedMessages.push(message);
  },
}));

mock.module("../../memory/conversation-crud.js", () => ({
  addMessage: async () => ({ id: "msg-1" }),
  getConversation: () => null,
  provenanceFromTrustContext: () => ({}),
}));

mock.module("../../memory/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
}));

mock.module("../../util/logger.js", () => ({
  getLogger: () => ({
    warn: () => {},
  }),
}));

import { conversationToWakeTarget } from "../wake-target-adapter.js";

describe("conversationToWakeTarget", () => {
  test("marks wake message_complete frames as main-turn completions", () => {
    broadcastedMessages.length = 0;

    const target = conversationToWakeTarget({
      conversationId: "conv-wake",
      agentLoop: {},
      getMessages: () => [],
      messages: [],
      isProcessing: () => false,
      processing: false,
      setTrustContext: () => {},
      getTurnChannelContext: () => null,
      getTurnInterfaceContext: () => null,
      drainQueue: async () => {},
    } as never);

    target.emitAgentEvent({
      type: "message_complete",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    } as Extract<AgentEvent, { type: "message_complete" }>);

    expect(broadcastedMessages).toEqual([
      {
        type: "message_complete",
        conversationId: "conv-wake",
        source: "main",
      },
    ]);
  });
});
