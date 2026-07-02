import { beforeEach, describe, expect, it } from "bun:test";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import {
  handleAcpSessionSpawned,
  handleAcpSessionUpdate,
  handleAcpSessionUsage,
  handleAcpSessionCompleted,
  handleAcpSessionError,
} from "@/domains/chat/utils/stream-handlers/acp-handlers";

function getState() {
  return useAcpRunStore.getState();
}

function spawn() {
  handleAcpSessionSpawned({
    type: "acp_session_spawned",
    acpSessionId: "acp-1",
    agent: "claude",
    parentConversationId: "conv-1",
    parentToolUseId: "tool-1",
    task: "research the thing",
  });
}

beforeEach(() => {
  getState().reset();
});

describe("handleAcpSessionSpawned", () => {
  it("spawns a running run with spawn context", () => {
    spawn();
    const entry = getState().byId["acp-1"];
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("running");
    expect(entry?.agent).toBe("claude");
    expect(entry?.parentConversationId).toBe("conv-1");
    expect(entry?.parentToolUseId).toBe("tool-1");
    expect(entry?.task).toBe("research the thing");
    expect(getState().orderedIds).toEqual(["acp-1"]);
    expect(getState().byToolUseId.get("tool-1")).toBe("acp-1");
  });
});

describe("handleAcpSessionUpdate", () => {
  it("appends an event and bumps the high-water mark", () => {
    spawn();
    handleAcpSessionUpdate({
      type: "acp_session_update",
      acpSessionId: "acp-1",
      updateType: "agent_message_chunk",
      content: "hello",
      messageId: "m-1",
      seq: 1,
    });
    expect(getState().byId["acp-1"]?.events).toHaveLength(1);
    expect(getState().byId["acp-1"]?.events[0]?.content).toBe("hello");
    expect(getState().highWaterMark.get("acp-1")).toBe(1);
  });

  it("plumbs locations into the store when present on the event", () => {
    spawn();
    handleAcpSessionUpdate({
      type: "acp_session_update",
      acpSessionId: "acp-1",
      updateType: "tool_call",
      toolCallId: "tc-1",
      seq: 1,
      locations: [{ path: "a.ts", line: 12 }, { path: "b.ts" }],
    });
    expect(getState().byId["acp-1"]?.events[0]?.locations).toEqual([
      { path: "a.ts", line: 12 },
      { path: "b.ts" },
    ]);
  });

  it("omits locations when absent on the event", () => {
    spawn();
    handleAcpSessionUpdate({
      type: "acp_session_update",
      acpSessionId: "acp-1",
      updateType: "tool_call",
      toolCallId: "tc-1",
      seq: 1,
    });
    expect(getState().byId["acp-1"]?.events[0]?.locations).toBeUndefined();
  });

  it("drops a replayed event at or below the high-water mark", () => {
    spawn();
    const update = {
      type: "acp_session_update",
      acpSessionId: "acp-1",
      updateType: "tool_call",
      seq: 1,
    } as const;
    handleAcpSessionUpdate(update);
    handleAcpSessionUpdate(update);
    expect(getState().byId["acp-1"]?.events).toHaveLength(1);
    expect(getState().highWaterMark.get("acp-1")).toBe(1);
  });

  it("keeps multiple seqless updates and never advances the high-water mark", () => {
    spawn();
    // Older assistants omit `seq`. Two seqless chunks (same receive tick) must
    // both land — appended without dedup, and the replay mark stays unset so a
    // later seqless chunk is never gated out.
    handleAcpSessionUpdate({
      type: "acp_session_update",
      acpSessionId: "acp-1",
      updateType: "agent_message_chunk",
      content: "first",
      messageId: "m-1",
    });
    handleAcpSessionUpdate({
      type: "acp_session_update",
      acpSessionId: "acp-1",
      updateType: "agent_message_chunk",
      content: "second",
      messageId: "m-2",
    });
    const events = getState().byId["acp-1"]?.events ?? [];
    expect(events.map((e) => e.content)).toEqual(["first", "second"]);
    expect(getState().highWaterMark.get("acp-1")).toBeUndefined();
  });
});

describe("handleAcpSessionUsage", () => {
  it("updates the run's used/size/cost usage", () => {
    spawn();
    handleAcpSessionUsage({
      type: "acp_session_usage",
      acpSessionId: "acp-1",
      usedTokens: 1500,
      contextSize: 200000,
      costAmount: 0.003,
      costCurrency: "USD",
    });
    const entry = getState().byId["acp-1"];
    expect(entry?.usedTokens).toBe(1500);
    expect(entry?.contextSize).toBe(200000);
    expect(entry?.costAmount).toBe(0.003);
    expect(entry?.costCurrency).toBe("USD");
  });

  it("maps cumulative input/output tokens into the store", () => {
    spawn();
    handleAcpSessionUsage({
      type: "acp_session_usage",
      acpSessionId: "acp-1",
      usedTokens: 1500,
      contextSize: 200000,
      inputTokens: 12000,
      outputTokens: 3400,
    });
    const entry = getState().byId["acp-1"];
    expect(entry?.inputTokens).toBe(12000);
    expect(entry?.outputTokens).toBe(3400);
  });

  it("ignores usage for an unknown session", () => {
    handleAcpSessionUsage({
      type: "acp_session_usage",
      acpSessionId: "acp-missing",
      usedTokens: 1,
      contextSize: 1,
    });
    expect(getState().byId).toEqual({});
  });
});

describe("handleAcpSessionCompleted", () => {
  it("marks the run completed with stop reason", () => {
    spawn();
    handleAcpSessionCompleted({
      type: "acp_session_completed",
      acpSessionId: "acp-1",
      stopReason: "end_turn",
    });
    const entry = getState().byId["acp-1"];
    expect(entry?.status).toBe("completed");
    expect(entry?.stopReason).toBe("end_turn");
    expect(entry?.completedAt).toBeGreaterThan(0);
  });

  it("preserves a cancelled run instead of regressing it to completed", () => {
    spawn();
    // The Stop action marks the run cancelled; a prompt that resolves during
    // the cancel window still emits acp_session_completed.
    getState().cancelRun({ acpSessionId: "acp-1", completedAt: Date.now() });
    handleAcpSessionCompleted({
      type: "acp_session_completed",
      acpSessionId: "acp-1",
      stopReason: "end_turn",
    });
    const entry = getState().byId["acp-1"];
    expect(entry?.status).toBe("cancelled");
    expect(entry?.stopReason).toBeUndefined();
  });

  it("resumes a completed run when respawned for the same id", () => {
    spawn();
    handleAcpSessionUpdate({
      type: "acp_session_update",
      acpSessionId: "acp-1",
      updateType: "agent_message_chunk",
      content: "hello",
      messageId: "m-1",
      seq: 1,
    });
    handleAcpSessionCompleted({
      type: "acp_session_completed",
      acpSessionId: "acp-1",
      stopReason: "end_turn",
    });
    expect(getState().byId["acp-1"]?.status).toBe("completed");

    // resumeFromHistory re-emits acp_session_spawned for the same id.
    spawn();

    const entry = getState().byId["acp-1"];
    expect(entry?.status).toBe("running");
    expect(entry?.stopReason).toBeUndefined();
    expect(entry?.completedAt).toBeUndefined();
    expect(entry?.events).toHaveLength(1);
  });
});

describe("handleAcpSessionError", () => {
  it("marks the run failed with the error message", () => {
    spawn();
    handleAcpSessionError({
      type: "acp_session_error",
      acpSessionId: "acp-1",
      error: "boom",
    });
    const entry = getState().byId["acp-1"];
    expect(entry?.status).toBe("failed");
    expect(entry?.error).toBe("boom");
    expect(entry?.completedAt).toBeGreaterThan(0);
  });

  it("preserves a cancelled run instead of regressing it to failed", () => {
    spawn();
    // The Stop action marks the run cancelled; the daemon then still emits
    // acp_session_error from the cancelled prompt's rejection.
    getState().cancelRun({ acpSessionId: "acp-1", completedAt: Date.now() });
    handleAcpSessionError({
      type: "acp_session_error",
      acpSessionId: "acp-1",
      error: "AbortError: cancelled",
    });
    const entry = getState().byId["acp-1"];
    expect(entry?.status).toBe("cancelled");
    expect(entry?.error).toBeUndefined();
  });
});
