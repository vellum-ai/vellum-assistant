import { beforeEach, describe, expect, it } from "bun:test";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { ACP_CLAUDE_AUTH_REQUIRED_CODE } from "@/domains/chat/utils/acp-connect";
import {
  handleAcpAuthRequired,
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

// ---------------------------------------------------------------------------
// Connect Claude affordance on an auth_required failure
// ---------------------------------------------------------------------------

describe("handleAcpAuthRequired", () => {
  beforeEach(() => {
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
    });
  });

  function authRequired(overrides: Record<string, unknown> = {}) {
    handleAcpAuthRequired({
      type: "acp_auth_required",
      acpSessionId: "acp-1",
      authCode: ACP_CLAUDE_AUTH_REQUIRED_CODE,
      agent: "claude",
      parentToolUseId: "tool-1",
      ...overrides,
    } as Parameters<typeof handleAcpAuthRequired>[0]);
  }

  it("raises the Connect prompt anchored to the run's spawning tool call", () => {
    spawn();
    authRequired();

    // Anchored to the acp_spawn call, not the run: that is the transcript row
    // the affordance renders under.
    expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
      toolUseId: "tool-1",
      reason: "auth_required",
    });
  });

  it("marks the prompt auth_required so it cannot self-dismiss on a presence check", () => {
    // The card's self-heal asks "is a token stored". Here one IS stored and the
    // agent rejected it, so answering that question must not retire the card.
    spawn();
    authRequired();

    expect(useInteractionStore.getState().pendingAcpConnect?.reason).toBe(
      "auth_required",
    );
  });

  it("falls back to the run store when the event carries no anchor", () => {
    // A session spawned before the daemon sent parentToolUseId on this event.
    spawn();
    authRequired({ parentToolUseId: undefined });

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-1",
    );
  });

  it("skips the prompt when there is no anchor anywhere", () => {
    // With no tool call to render under, the run keeps its plain failed
    // rendering rather than putting a card in the wrong place.
    authRequired({ acpSessionId: "acp-unknown", parentToolUseId: undefined });

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  it("ignores an auth code it does not recognize", () => {
    spawn();
    authRequired({ authCode: "some_future_agent_auth" });

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  it("does not raise a prompt for a cancelled run", () => {
    spawn();
    getState().cancelRun({ acpSessionId: "acp-1", completedAt: Date.now() });
    authRequired();

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });
});

describe("handleAcpSessionError stays additive-safe", () => {
  beforeEach(() => {
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
    });
  });

  it("marks the run failed and raises nothing on its own", () => {
    // The failure event keeps its pre-existing shape so an older packaged
    // client still parses it; the recovery signal rides its own event.
    spawn();
    handleAcpSessionError({
      type: "acp_session_error",
      acpSessionId: "acp-1",
      error:
        "Failed to authenticate. API Error: 401 OAuth access token expired",
    });

    expect(getState().byId["acp-1"]?.status).toBe("failed");
    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });
});
