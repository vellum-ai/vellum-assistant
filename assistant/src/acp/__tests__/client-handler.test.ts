import { describe, expect, test } from "bun:test";

import type { SessionNotification } from "@agentclientprotocol/sdk";

import type { ServerMessage } from "../../daemon/message-protocol.js";
import { VellumAcpClientHandler } from "../client-handler.js";

const ACP_SESSION_ID = "acp-session-abc";
const PARENT_CONVERSATION_ID = "conv-xyz";

function makeHandler(): {
  handler: VellumAcpClientHandler;
  sent: ServerMessage[];
} {
  const sent: ServerMessage[] = [];
  const handler = new VellumAcpClientHandler(
    ACP_SESSION_ID,
    (msg) => {
      sent.push(msg);
    },
    PARENT_CONVERSATION_ID,
  );
  return { handler, sent };
}

describe("VellumAcpClientHandler.sessionUpdate", () => {
  test("forwards agent_thought_chunk as an acp_session_update", async () => {
    const { handler, sent } = makeHandler();

    const notification: SessionNotification = {
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "internal reasoning here" },
      },
    };

    await handler.sessionUpdate(notification);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "acp_session_update",
      acpSessionId: ACP_SESSION_ID,
      updateType: "agent_thought_chunk",
      content: "internal reasoning here",
    });
  });

  test("agent_thought_chunk does not contribute to accumulated response text", async () => {
    const { handler } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking..." },
      },
    });

    // Thoughts are forwarded for UI display but should not be treated as the
    // agent's final response text.
    expect(handler.responseText).toBe("");
  });
});
