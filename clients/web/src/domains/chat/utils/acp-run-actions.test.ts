/**
 * Tests for the ACP run actions (stop / steer / close).
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
const { stopAcpRun, steerAcpRun, closeAcpRun } = await import(
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

describe("closeAcpRun", () => {
  test("POSTs the close route with the assistant + session ids", async () => {
    await closeAcpRun("acp-1");
    expect(calls[0]!.url).toBe("/v1/assistants/{assistant_id}/acp/{id}/close");
    expect(calls[0]!.path).toEqual({ assistant_id: "asst-1", id: "acp-1" });
  });
});

describe("no active assistant", () => {
  test("throws before issuing a request", async () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    await expect(stopAcpRun("acp-1")).rejects.toThrow("No active assistant");
    expect(calls).toHaveLength(0);
  });
});
