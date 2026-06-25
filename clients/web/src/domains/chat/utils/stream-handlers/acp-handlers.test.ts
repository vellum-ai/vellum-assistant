import { beforeEach, describe, expect, it } from "bun:test";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import {
  handleAcpSessionSpawned,
  handleAcpSessionUpdate,
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
});
