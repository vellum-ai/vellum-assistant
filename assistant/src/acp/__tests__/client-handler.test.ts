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

  test("tool_call forwards initial content[] (no follow-up update)", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-content",
        title: "Run tests",
        kind: "execute",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "stdout line" } },
        ],
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      updateType: "tool_call",
      toolCallId: "tc-content",
      content: JSON.stringify([
        { type: "content", content: { type: "text", text: "stdout line" } },
      ]),
    });
  });

  test("tool_call forwards rawInput/rawOutput structurally when present", async () => {
    const { handler, sent } = makeHandler();

    const rawInput = { command: "ls", args: ["-la"] };
    const rawOutput = { stdout: "file.txt", exitCode: 0 };

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-raw",
        title: "Run ls",
        kind: "execute",
        status: "completed",
        rawInput,
        rawOutput,
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      updateType: "tool_call",
      toolCallId: "tc-raw",
      // Forwarded as-is, NOT stringified (unlike content).
      rawInput: { command: "ls", args: ["-la"] },
      rawOutput: { stdout: "file.txt", exitCode: 0 },
    });
  });

  test("tool_call leaves rawInput/rawOutput undefined when source omits them", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-no-raw",
        title: "Edit main.ts",
        kind: "edit",
        status: "pending",
      },
    });

    expect(sent).toHaveLength(1);
    const msg = sent[0] as { rawInput?: unknown; rawOutput?: unknown };
    expect(msg.rawInput).toBeUndefined();
    expect(msg.rawOutput).toBeUndefined();
  });

  test("tool_call_update forwards rawInput/rawOutput structurally when present", async () => {
    const { handler, sent } = makeHandler();

    const rawInput = { path: "/repo/main.ts", oldText: "a", newText: "b" };
    const rawOutput = { applied: true };

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-raw-update",
        status: "completed",
        rawInput,
        rawOutput,
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      updateType: "tool_call_update",
      toolCallId: "tc-raw-update",
      rawInput: { path: "/repo/main.ts", oldText: "a", newText: "b" },
      rawOutput: { applied: true },
    });
  });

  test("tool_call forwards a small rawOutput unchanged (under the cap)", async () => {
    const { handler, sent } = makeHandler();

    const rawOutput = { ok: true };

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-small-raw",
        title: "Run check",
        kind: "execute",
        status: "completed",
        rawOutput,
      },
    });

    expect(sent).toHaveLength(1);
    const msg = sent[0] as { rawOutput?: unknown };
    // Under the 16 KiB cap — forwarded structurally, unchanged.
    expect(msg.rawOutput).toEqual({ ok: true });
  });

  test("tool_call caps an oversize rawOutput to a marker string", async () => {
    const { handler, sent } = makeHandler();

    const huge = "x".repeat(20000);
    const rawOutput = { stdout: huge };

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-oversize-raw",
        title: "Run noisy command",
        kind: "execute",
        status: "completed",
        rawOutput,
      },
    });

    expect(sent).toHaveLength(1);
    const msg = sent[0] as { rawOutput?: unknown };
    // Oversize payloads are replaced with a short marker so a single large
    // rawOutput can't evict real transcript events from the session buffer.
    expect(typeof msg.rawOutput).toBe("string");
    expect(msg.rawOutput as string).toStartWith("[raw payload omitted:");
    // The original large value must not survive into the forwarded event.
    expect(JSON.stringify(sent[0])).not.toContain(huge);
  });

  test("tool_call caps an oversize rawInput to a marker string", async () => {
    const { handler, sent } = makeHandler();

    const huge = "y".repeat(20000);
    const rawInput = { prompt: huge };

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-oversize-input",
        title: "Run big prompt",
        kind: "execute",
        status: "pending",
        rawInput,
      },
    });

    expect(sent).toHaveLength(1);
    const msg = sent[0] as { rawInput?: unknown };
    expect(typeof msg.rawInput).toBe("string");
    expect(msg.rawInput as string).toStartWith("[raw payload omitted:");
    expect(JSON.stringify(sent[0])).not.toContain(huge);
  });

  test("tool_call_update leaves rawInput/rawOutput undefined when source omits them", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-no-raw-update",
        status: "in_progress",
      },
    });

    expect(sent).toHaveLength(1);
    const msg = sent[0] as { rawInput?: unknown; rawOutput?: unknown };
    expect(msg.rawInput).toBeUndefined();
    expect(msg.rawOutput).toBeUndefined();
  });

  test("tool_call_update forwards locations: [] when null (explicit clear)", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-clear",
        status: "completed",
        // ACP `null` means "replace the locations collection with empty".
        // We forward an empty array so web clears its prior locations.
        locations: null,
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      updateType: "tool_call_update",
      toolCallId: "tc-clear",
      locations: [],
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

  test("tool_call redacts secrets in rawInput/rawOutput before forwarding", async () => {
    const { handler, sent } = makeHandler();

    // AWS access key id — a high-confidence prefix-based secret pattern.
    const secret = "AKIAIOSFODNN7REALKEY";

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-secret",
        title: "Configure AWS",
        kind: "execute",
        status: "completed",
        rawInput: { env: { AWS_ACCESS_KEY_ID: secret } },
        rawOutput: { echoed: `key is ${secret}` },
      },
    });

    expect(sent).toHaveLength(1);
    // The raw secret must not survive into the forwarded event, which flows
    // into the session buffer and the persisted event_log_json.
    expect(JSON.stringify(sent[0])).not.toContain(secret);
    const msg = sent[0] as { rawInput?: unknown; rawOutput?: unknown };
    expect(JSON.stringify(msg.rawInput)).toContain("<redacted");
    expect(JSON.stringify(msg.rawOutput)).toContain("<redacted");
  });

  test("tool_call_update redacts secrets in rawInput/rawOutput before forwarding", async () => {
    const { handler, sent } = makeHandler();

    const secret = "AKIAIOSFODNN7REALKEY";

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-secret-update",
        status: "completed",
        rawInput: { token: secret },
        rawOutput: { stdout: secret },
      },
    });

    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toContain(secret);
    const msg = sent[0] as { rawInput?: unknown; rawOutput?: unknown };
    expect(JSON.stringify(msg.rawInput)).toContain("<redacted");
    expect(JSON.stringify(msg.rawOutput)).toContain("<redacted");
  });

  test("tool_call redacts credential-named fields whose values aren't secret-shaped", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-cred",
        title: "Configure",
        kind: "execute",
        status: "completed",
        // Plain words — caught by field NAME, not by value shape.
        rawInput: {
          password: "correcthorsebattery",
          nested: { api_key: "plainword" },
        },
        rawOutput: { token: "notasecretbutlong" },
      },
    });

    expect(sent).toHaveLength(1);
    const serialized = JSON.stringify(sent[0]);
    expect(serialized).not.toContain("correcthorsebattery");
    expect(serialized).not.toContain("plainword");
    expect(serialized).not.toContain("notasecretbutlong");
    expect(serialized).toContain("<redacted");
  });

  test("tool_call redacts credential-named fields nested inside arrays of arrays", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-nested-array",
        title: "Batch",
        kind: "execute",
        status: "completed",
        // Credential-named field buried under array-in-array nesting; the
        // value isn't secret-shaped, so only field-name redaction catches it.
        rawInput: { calls: [[{ token: "plainword" }]] },
      },
    });

    expect(sent).toHaveLength(1);
    const serialized = JSON.stringify(sent[0]);
    expect(serialized).not.toContain("plainword");
    expect(serialized).toContain("<redacted");
  });

  test("tool_call_update redacts credential-named fields whose values aren't secret-shaped", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-cred-update",
        status: "completed",
        rawInput: { authorization: "plainwordvalue" },
        rawOutput: { secret: "justwords" },
      },
    });

    expect(sent).toHaveLength(1);
    const serialized = JSON.stringify(sent[0]);
    expect(serialized).not.toContain("plainwordvalue");
    expect(serialized).not.toContain("justwords");
    expect(serialized).toContain("<redacted");
  });

  test("tool_call redacts a shaped secret embedded in the title", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-title",
        // Claude's shell tools put the command in the title; a literal
        // credential inline must not reach the wire or persisted event log.
        title: "echo AKIAQ7XK4PNZ3RJD2WTV",
        kind: "execute",
        status: "completed",
      },
    });

    expect(sent).toHaveLength(1);
    const msg = sent[0] as { toolTitle?: string };
    expect(msg.toolTitle).not.toContain("AKIAQ7XK4PNZ3RJD2WTV");
    expect(msg.toolTitle).toContain("<redacted");
  });

  test("tool_call_update redacts a shaped secret embedded in the title", async () => {
    const { handler, sent } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-title-update",
        title: "echo AKIAFA01L49X7HW9DM2Y",
        status: "completed",
      },
    });

    expect(sent).toHaveLength(1);
    const msg = sent[0] as { toolTitle?: string };
    expect(msg.toolTitle).not.toContain("AKIAFA01L49X7HW9DM2Y");
    expect(msg.toolTitle).toContain("<redacted");
  });
});
