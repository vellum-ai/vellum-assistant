/**
 * Tests for the ACP run actions (stop / steer).
 *
 * The ACP routes are excluded from the generated daemon SDK, so the actions
 * call `client.post` directly. Mock the daemon client to assert the request
 * shape (url template + path params + body) and stage responses.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface PostCall {
  url: string;
  path?: Record<string, string>;
  body?: Record<string, unknown>;
}

const calls: PostCall[] = [];
let nextData: unknown = undefined;
let nextOk = true;
let nextStatus = 200;

mock.module("@/generated/daemon/client.gen", () => ({
  client: {
    post: async (options: PostCall) => {
      calls.push(options);
      return {
        data: nextData,
        response: { ok: nextOk, status: nextStatus },
      };
    },
  },
}));

const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);
const { useAcpRunStore } = await import("@/domains/chat/acp-run-store");
const { stopAcpRun, steerAcpRun } = await import(
  "@/domains/chat/utils/acp-run-actions"
);

beforeEach(() => {
  calls.length = 0;
  nextData = undefined;
  nextOk = true;
  nextStatus = 200;
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
});

afterEach(() => {
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

describe("stopAcpRun", () => {
  test("POSTs the cancel route with the assistant + session ids", async () => {
    await stopAcpRun("acp-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "/v1/assistants/{assistant_id}/acp/{id}/cancel",
    );
    expect(calls[0]!.path).toEqual({ assistant_id: "asst-1", id: "acp-1" });
  });

  test("throws on a non-ok response", async () => {
    nextOk = false;
    nextStatus = 404;
    await expect(stopAcpRun("acp-1")).rejects.toThrow();
  });

  test("optimistically marks the active run cancelled", async () => {
    useAcpRunStore.getState().reset();
    useAcpRunStore.getState().spawnRun({
      acpSessionId: "acp-1",
      agent: "claude",
      parentConversationId: "conv-1",
      startedAt: 1,
    });

    await stopAcpRun("acp-1");

    expect(useAcpRunStore.getState().byId["acp-1"]!.status).toBe("cancelled");
    useAcpRunStore.getState().reset();
  });

  test("rolls back the optimistic cancel when the POST fails", async () => {
    useAcpRunStore.getState().reset();
    useAcpRunStore.getState().spawnRun({
      acpSessionId: "acp-1",
      agent: "claude",
      parentConversationId: "conv-1",
      startedAt: 1,
    });
    nextOk = false;
    nextStatus = 500;

    await expect(stopAcpRun("acp-1")).rejects.toThrow();

    // Restored to running (the Stop control reappears), not stuck cancelled.
    const entry = useAcpRunStore.getState().byId["acp-1"]!;
    expect(entry.status).toBe("running");
    expect(entry.completedAt).toBeUndefined();
    useAcpRunStore.getState().reset();
  });

  test("does not optimistically cancel when there is no active assistant", async () => {
    useAcpRunStore.getState().reset();
    useAcpRunStore.getState().spawnRun({
      acpSessionId: "acp-1",
      agent: "claude",
      parentConversationId: "conv-1",
      startedAt: 1,
    });
    useResolvedAssistantsStore.setState({ activeAssistantId: null });

    await expect(stopAcpRun("acp-1")).rejects.toThrow("No active assistant");

    // The precondition is resolved before the optimistic write, so the run is
    // never flipped to cancelled.
    expect(useAcpRunStore.getState().byId["acp-1"]!.status).toBe("running");
    expect(calls).toHaveLength(0);
    useAcpRunStore.getState().reset();
  });
});

describe("steerAcpRun", () => {
  test("POSTs the steer route with the instruction and returns the response", async () => {
    nextData = { acpSessionId: "acp-1", steered: true, resumed: true };
    const res = await steerAcpRun("acp-1", "focus on tests");
    expect(calls[0]!.url).toBe("/v1/assistants/{assistant_id}/acp/{id}/steer");
    expect(calls[0]!.path).toEqual({ assistant_id: "asst-1", id: "acp-1" });
    expect(calls[0]!.body).toEqual({ instruction: "focus on tests" });
    expect(res).toEqual({
      acpSessionId: "acp-1",
      steered: true,
      resumed: true,
    });
  });

  test("surfaces approvalPending from the response", async () => {
    nextData = { acpSessionId: "acp-1", steered: false, approvalPending: true };
    const res = await steerAcpRun("acp-1", "resume");
    expect(res.approvalPending).toBe(true);
  });
});

describe("no active assistant", () => {
  test("throws before issuing a request", async () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    await expect(stopAcpRun("acp-1")).rejects.toThrow("No active assistant");
    expect(calls).toHaveLength(0);
  });
});
