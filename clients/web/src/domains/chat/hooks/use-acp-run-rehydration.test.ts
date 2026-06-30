/**
 * Tests for `fetchAcpSessions` + store seeding behaviour. We mock the
 * generated daemon `client` (the fetch calls `client.get` under the hood) so
 * we can stage `/acp/sessions` responses and assert the rehydrated timeline,
 * terminal status/usage, and seq high-water-mark dedup.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface FakeRequest {
  url: string;
  path?: Record<string, string>;
  query?: Record<string, unknown>;
}

interface FakeResponse {
  status: number;
  body?: unknown;
}

const requests: FakeRequest[] = [];
let nextResponses: FakeResponse[] = [];

mock.module("@/generated/daemon/client.gen", () => ({
  client: {
    get: async ({
      url,
      path,
      query,
    }: {
      url: string;
      path?: Record<string, string>;
      query?: Record<string, unknown>;
      throwOnError?: boolean;
    }) => {
      requests.push({ url, path, query });
      const next = nextResponses.shift();
      if (!next) throw new Error(`No staged response for ${url}`);
      const response = {
        status: next.status,
        ok: next.status >= 200 && next.status < 300,
      };
      return { data: next.body, response };
    },
  },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

// Subject imported after mocks.
import { fetchAcpSessions } from "@/domains/chat/hooks/use-acp-run-rehydration";
import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { handleAcpSessionUpdate } from "@/domains/chat/utils/stream-handlers/acp-handlers";
import { computeAcpRunSteps } from "@/domains/chat/acp-run-step-projection";

function getState() {
  return useAcpRunStore.getState();
}

beforeEach(() => {
  requests.length = 0;
  nextResponses = [];
  getState().reset();
});

afterEach(() => {
  getState().reset();
});

async function seed(sessions: unknown[]): Promise<void> {
  nextResponses = [{ status: 200, body: { sessions } }];
  const entries = await fetchAcpSessions("asst-1", "conv-1");
  getState().seedFromHistory(entries ?? []);
}

describe("fetchAcpSessions", () => {
  test("requests the assistant-scoped acp/sessions route with the conversation id", async () => {
    nextResponses = [{ status: 200, body: { sessions: [] } }];
    await fetchAcpSessions("asst-1", "conv-1");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/v1/assistants/{assistant_id}/acp/sessions");
    expect(requests[0]!.path).toEqual({ assistant_id: "asst-1" });
    expect(requests[0]!.query).toEqual({ conversationId: "conv-1", limit: 50 });
  });

  test("returns null on a non-ok response (distinct from an empty snapshot)", async () => {
    nextResponses = [{ status: 500, body: null }];
    expect(await fetchAcpSessions("asst-1", "conv-1")).toBeNull();
  });
});

describe("rehydration — terminal session", () => {
  test("reconstructs the timeline with terminal status and usage", async () => {
    await seed([
      {
        id: "acp-1",
        acpSessionId: "proto-1",
        agentId: "claude",
        parentConversationId: "conv-1",
        parentToolUseId: "tool-1",
        task: "research",
        status: "completed",
        stopReason: "end_turn",
        startedAt: 1000,
        completedAt: 5000,
        usedTokens: 4200,
        contextSize: 200000,
        costAmount: 0.0123,
        costCurrency: "USD",
        eventLog: [
          {
            type: "acp_session_update",
            updateType: "agent_message_chunk",
            content: "hi",
            messageId: "m-1",
            seq: 3,
          },
          {
            type: "acp_session_update",
            updateType: "tool_call",
            toolCallId: "t-1",
            toolTitle: "Read",
            seq: 7,
          },
        ],
      },
    ]);

    const entry = getState().byId["acp-1"]!;
    expect(entry.status).toBe("completed");
    expect(entry.stopReason).toBe("end_turn");
    expect(entry.completedAt).toBe(5000);
    expect(entry.startedAt).toBe(1000);
    expect(entry.agent).toBe("claude");
    expect(entry.task).toBe("research");
    expect(entry.parentToolUseId).toBe("tool-1");
    expect(entry.usedTokens).toBe(4200);
    expect(entry.contextSize).toBe(200000);
    expect(entry.costAmount).toBe(0.0123);
    expect(entry.costCurrency).toBe("USD");
    expect(entry.events).toHaveLength(2);
    expect(entry.events[1]!.toolCallId).toBe("t-1");
    expect(getState().highWaterMark.get("acp-1")).toBe(7);
    // The transcript anchors the inline card off `parentToolUseId`.
    expect(getState().byToolUseId.get("tool-1")).toBe("acp-1");
  });

  test("carries tool-call locations onto the rehydrated event", async () => {
    await seed([
      {
        id: "acp-1",
        acpSessionId: "proto-1",
        agentId: "claude",
        parentConversationId: "conv-1",
        status: "completed",
        startedAt: 1000,
        completedAt: 5000,
        eventLog: [
          {
            type: "acp_session_update",
            updateType: "tool_call",
            toolCallId: "t-1",
            toolTitle: "Edit",
            locations: [{ path: "/src/a.ts", line: 12 }, { path: "/src/b.ts" }],
            seq: 4,
          },
        ],
      },
    ]);

    const event = getState().byId["acp-1"]!.events[0]!;
    expect(event.locations).toEqual([
      { path: "/src/a.ts", line: 12 },
      { path: "/src/b.ts" },
    ]);
  });

  test("carries persisted rawInput/rawOutput onto the rehydrated event", async () => {
    await seed([
      {
        id: "acp-1",
        acpSessionId: "proto-1",
        agentId: "claude",
        parentConversationId: "conv-1",
        status: "completed",
        startedAt: 1000,
        completedAt: 5000,
        eventLog: [
          {
            type: "acp_session_update",
            updateType: "tool_call",
            toolCallId: "t-1",
            toolTitle: "Bash",
            rawInput: { command: "ls -la" },
            rawOutput: "total 0",
            seq: 4,
          },
        ],
      },
    ]);

    // Raw I/O survives history rehydration so a reopened run keeps it.
    const event = getState().byId["acp-1"]!.events[0]!;
    expect(event.rawInput).toEqual({ command: "ls -la" });
    expect(event.rawOutput).toBe("total 0");
  });

  test("carries cumulative input/output tokens from the session row", async () => {
    await seed([
      {
        id: "acp-1",
        acpSessionId: "proto-1",
        agentId: "claude",
        parentConversationId: "conv-1",
        status: "completed",
        startedAt: 1000,
        completedAt: 5000,
        inputTokens: 12000,
        outputTokens: 3400,
        eventLog: [],
      },
    ]);

    const entry = getState().byId["acp-1"]!;
    expect(entry.inputTokens).toBe(12000);
    expect(entry.outputTokens).toBe(3400);
  });

  test("a pre-migration row without usage hides the meter and degrades gracefully", async () => {
    await seed([
      {
        id: "acp-1",
        acpSessionId: "proto-1",
        agentId: "claude",
        parentConversationId: "conv-1",
        status: "completed",
        stopReason: "end_turn",
        startedAt: 1000,
        completedAt: 5000,
        eventLog: [],
      },
    ]);

    const entry = getState().byId["acp-1"]!;
    expect(entry.status).toBe("completed");
    expect(entry.usedTokens).toBe(0);
    expect(entry.contextSize).toBe(0);
    expect(entry.inputTokens).toBeUndefined();
    expect(entry.outputTokens).toBeUndefined();
    expect(entry.costAmount).toBeUndefined();
    expect(entry.costCurrency).toBeUndefined();
  });

  test("leaves seq undefined when absent and never advances the high-water mark", async () => {
    await seed([
      {
        id: "acp-1",
        acpSessionId: "proto-1",
        agentId: "claude",
        parentConversationId: "conv-1",
        status: "completed",
        startedAt: 1000,
        eventLog: [
          {
            type: "acp_session_update",
            updateType: "tool_call",
            toolCallId: "t-0",
          },
          {
            type: "acp_session_update",
            updateType: "tool_call",
            toolCallId: "t-1",
          },
        ],
      },
    ]);

    // Seqless events keep `seq` undefined: a synthetic index would seed the
    // high-water mark above the daemon's resume counter (which it derives from
    // numeric seqs only), dropping the first live updates after resume.
    expect(getState().byId["acp-1"]!.events.map((e) => e.seq)).toEqual([
      undefined,
      undefined,
    ]);
    expect(getState().highWaterMark.get("acp-1")).toBeUndefined();
  });
});

describe("rehydration — active session + live stream dedup", () => {
  test("drops a subsequent live event at or below the seeded high-water mark", async () => {
    await seed([
      {
        id: "acp-1",
        acpSessionId: "proto-1",
        agentId: "claude",
        parentConversationId: "conv-1",
        status: "running",
        startedAt: 1000,
        eventLog: [
          {
            type: "acp_session_update",
            updateType: "agent_message_chunk",
            content: "seeded",
            messageId: "m-1",
            seq: 5,
          },
        ],
      },
    ]);

    expect(getState().byId["acp-1"]!.status).toBe("running");
    expect(getState().byId["acp-1"]!.events).toHaveLength(1);
    expect(getState().highWaterMark.get("acp-1")).toBe(5);

    // Replayed event at the mark is dropped — no double apply.
    handleAcpSessionUpdate({
      type: "acp_session_update",
      acpSessionId: "acp-1",
      updateType: "tool_call",
      toolCallId: "t-dup",
      seq: 5,
    });

    expect(getState().byId["acp-1"]!.events).toHaveLength(1);
  });

  test("applies a live event with seq above the seeded high-water mark", async () => {
    await seed([
      {
        id: "acp-1",
        acpSessionId: "proto-1",
        agentId: "claude",
        parentConversationId: "conv-1",
        status: "running",
        startedAt: 1000,
        eventLog: [
          {
            type: "acp_session_update",
            updateType: "agent_message_chunk",
            content: "seeded",
            messageId: "m-1",
            seq: 5,
          },
        ],
      },
    ]);

    handleAcpSessionUpdate({
      type: "acp_session_update",
      acpSessionId: "acp-1",
      updateType: "tool_call",
      toolCallId: "t-new",
      seq: 6,
    });

    const events = getState().byId["acp-1"]!.events;
    expect(events).toHaveLength(2);
    expect(events[1]!.toolCallId).toBe("t-new");
    expect(getState().highWaterMark.get("acp-1")).toBe(6);
  });

  test("a live event that arrived before seeding survives a stale-but-longer snapshot", async () => {
    // Live spawn + an event with seq above the history snapshot's max arrives
    // BEFORE the /acp/sessions response resolves.
    getState().spawnRun({
      acpSessionId: "acp-1",
      agent: "claude",
      parentConversationId: "conv-1",
      startedAt: 1000,
    });
    handleAcpSessionUpdate({
      type: "acp_session_update",
      acpSessionId: "acp-1",
      updateType: "tool_call",
      toolCallId: "t-live",
      seq: 9,
    });
    expect(getState().highWaterMark.get("acp-1")).toBe(9);

    // Stale-but-longer history snapshot: more events, but max seq 3 < 9.
    await seed([
      {
        id: "acp-1",
        acpSessionId: "proto-1",
        agentId: "claude",
        parentConversationId: "conv-1",
        status: "running",
        startedAt: 1000,
        eventLog: [
          {
            type: "acp_session_update",
            updateType: "tool_call",
            toolCallId: "h-1",
            seq: 1,
          },
          {
            type: "acp_session_update",
            updateType: "tool_call",
            toolCallId: "h-2",
            seq: 2,
          },
          {
            type: "acp_session_update",
            updateType: "tool_call",
            toolCallId: "h-3",
            seq: 3,
          },
        ],
      },
    ]);

    const events = getState().byId["acp-1"]!.events;
    // The live seq=9 event is not dropped; older history events fill in.
    expect(events.find((e) => e.toolCallId === "t-live")).toBeDefined();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 9]);
    // highWaterMark reflects the true newest seq, keeping live dedup correct.
    expect(getState().highWaterMark.get("acp-1")).toBe(9);

    // A later live event at or below the mark is still deduped.
    handleAcpSessionUpdate({
      type: "acp_session_update",
      acpSessionId: "acp-1",
      updateType: "tool_call",
      toolCallId: "t-dup",
      seq: 9,
    });
    expect(getState().byId["acp-1"]!.events).toHaveLength(4);
  });

  test("history chunks merging with live chunks do not duplicate message text", async () => {
    // Regression: the raw buffer no longer coalesces, so a history snapshot of
    // individual chunks unions with the live chunks by seq instead of mixing
    // pre-coalesced live text with the same persisted chunks (which rendered
    // "aab" instead of "ab").
    getState().spawnRun({
      acpSessionId: "acp-1",
      agent: "claude",
      parentConversationId: "conv-1",
      startedAt: 1000,
    });
    handleAcpSessionUpdate({
      type: "acp_session_update",
      acpSessionId: "acp-1",
      updateType: "agent_message_chunk",
      content: "a",
      messageId: "m-1",
      seq: 1,
    });
    handleAcpSessionUpdate({
      type: "acp_session_update",
      acpSessionId: "acp-1",
      updateType: "agent_message_chunk",
      content: "b",
      messageId: "m-1",
      seq: 2,
    });

    await seed([
      {
        id: "acp-1",
        acpSessionId: "proto-1",
        agentId: "claude",
        parentConversationId: "conv-1",
        status: "running",
        startedAt: 1000,
        eventLog: [
          {
            type: "acp_session_update",
            updateType: "agent_message_chunk",
            content: "a",
            messageId: "m-1",
            seq: 1,
          },
          {
            type: "acp_session_update",
            updateType: "agent_message_chunk",
            content: "b",
            messageId: "m-1",
            seq: 2,
          },
        ],
      },
    ]);

    const events = getState().byId["acp-1"]!.events;
    expect(events.map((e) => e.content)).toEqual(["a", "b"]);
    const steps = computeAcpRunSteps(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "message", content: "ab" });
  });
});
