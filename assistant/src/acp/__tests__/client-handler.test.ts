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
      seq: 1,
      updateType: "agent_thought_chunk",
      content: "internal reasoning here",
      messageId: undefined,
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

describe("VellumAcpClientHandler replay suppression", () => {
  function messageChunk(text: string): SessionNotification {
    return {
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    };
  }

  test("updates received while suppressed are dropped", async () => {
    const { handler, sent } = makeHandler();

    handler.beginReplaySuppression();
    await handler.sessionUpdate(messageChunk("replayed history"));

    expect(sent).toHaveLength(0);
    expect(handler.responseText).toBe("");
  });

  test("updates after endReplaySuppression() flow normally", async () => {
    const { handler, sent } = makeHandler();

    handler.beginReplaySuppression();
    await handler.sessionUpdate(messageChunk("replayed history"));
    handler.endReplaySuppression();
    await handler.sessionUpdate(messageChunk("live response"));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "acp_session_update",
      acpSessionId: ACP_SESSION_ID,
      seq: 1,
      updateType: "agent_message_chunk",
      content: "live response",
      messageId: undefined,
    });
    expect(handler.responseText).toBe("live response");
  });

  test("seq is not consumed by updates dropped during suppression", async () => {
    const { handler, sent } = makeHandler();

    handler.beginReplaySuppression();
    await handler.sessionUpdate(messageChunk("replayed one"));
    await handler.sessionUpdate(messageChunk("replayed two"));
    handler.endReplaySuppression();

    // The first forwarded event must start at seq 1: suppressed replays
    // never advanced the counter.
    await handler.sessionUpdate(messageChunk("live one"));
    await handler.sessionUpdate(messageChunk("live two"));

    expect(sent.map((m) => (m as { seq: number }).seq)).toEqual([1, 2]);
  });
});

describe("VellumAcpClientHandler seq + enriched fields", () => {
  test("seq increments monotonically per forwarded event", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "a" },
      },
    });
    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "b" },
      },
    });
    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "plan",
        entries: [],
      },
    });

    expect(sent.map((m) => (m as { seq: number }).seq)).toEqual([1, 2, 3]);
  });

  test("seedSeq continues seq past the persisted max after resume", async () => {
    const { handler, sent } = makeHandler();

    // Simulate resume: a fresh handler re-seeded from a persisted log whose
    // updates carried seq up to 5.
    handler.seedSeq(5);

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "live after resume" },
      },
    });

    // The first live update must continue at 6 (N + 1), not reset to 1, so
    // the web client's highWaterMark de-dupe doesn't drop it.
    expect((sent[0] as { seq: number }).seq).toBe(6);
  });

  test("seedSeq ignores smaller or non-finite values", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "a" },
      },
    });
    // Already at seq 1; a smaller/NaN seed must not regress the counter.
    handler.seedSeq(0);
    handler.seedSeq(Number.NaN);

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "b" },
      },
    });

    expect(sent.map((m) => (m as { seq: number }).seq)).toEqual([1, 2]);
  });

  test("forwards ContentChunk messageId on message chunks", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
        messageId: "msg-42",
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      updateType: "agent_message_chunk",
      content: "hello",
      messageId: "msg-42",
      seq: 1,
    });
  });

  test("usage_update is forwarded as acp_session_usage with mapped fields and no seq", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "usage_update",
        used: 1200,
        size: 200000,
        cost: { amount: 0.42, currency: "USD" },
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "acp_session_usage",
      acpSessionId: ACP_SESSION_ID,
      usedTokens: 1200,
      contextSize: 200000,
      costAmount: 0.42,
      costCurrency: "USD",
    });
    // Usage is a side gauge, not part of the ordered timeline — no seq.
    expect(sent[0]).not.toHaveProperty("seq");
  });

  test("usage_update without cost yields undefined costAmount/costCurrency", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "usage_update",
        used: 50,
        size: 100,
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "acp_session_usage",
      usedTokens: 50,
      contextSize: 100,
      costAmount: undefined,
      costCurrency: undefined,
    });
  });

  test("usage_update does not advance the seq counter", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "usage_update",
        used: 1,
        size: 2,
      },
    });
    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "after usage" },
      },
    });

    // The first real update must still start at seq 1.
    expect((sent[1] as { seq: number }).seq).toBe(1);
  });

  test("usage_update is dropped during replay suppression", async () => {
    const { handler, sent } = makeHandler();

    handler.beginReplaySuppression();
    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "usage_update",
        used: 10,
        size: 20,
        cost: { amount: 1, currency: "USD" },
      },
    });

    expect(sent).toHaveLength(0);
  });

  test("tool_call_update carries toolTitle and toolKind", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        title: "Edit main.ts",
        kind: "edit",
        status: "in_progress",
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      updateType: "tool_call_update",
      toolCallId: "tc-1",
      toolTitle: "Edit main.ts",
      toolKind: "edit",
      toolStatus: "in_progress",
      seq: 1,
    });
  });

  test("tool_call_update forwards locations[] when present", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-2",
        status: "completed",
        locations: [
          { path: "/repo/src/main.ts", line: 42 },
          { path: "/repo/src/util.ts" },
        ],
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      updateType: "tool_call_update",
      toolCallId: "tc-2",
      locations: [
        { path: "/repo/src/main.ts", line: 42 },
        { path: "/repo/src/util.ts", line: undefined },
      ],
    });
  });

  test("tool_call forwards locations[] when present", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-3",
        title: "Edit main.ts",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/repo/src/main.ts", line: 7 }],
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      updateType: "tool_call",
      toolCallId: "tc-3",
      locations: [{ path: "/repo/src/main.ts", line: 7 }],
    });
  });

  test("tool_call_update omits locations key when absent", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-4",
        status: "in_progress",
      },
    });

    expect(sent).toHaveLength(1);
    const msg = sent[0] as { locations?: unknown };
    expect(msg.locations).toBeUndefined();
    expect("locations" in msg && msg.locations !== undefined).toBe(false);
  });
});
