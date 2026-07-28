import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ChannelReplyPayload } from "@vellumai/gateway-client";

import type { A2ATask, Artifact } from "../../../../a2a/protocol-types.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let completedTask: A2ATask | null = null;
let completeWithArtifactsCalls: Array<{
  taskId: string;
  artifacts: Artifact[];
}> = [];
let pushUrlByTaskId: Record<string, string | null> = {};
let completeError: Error | null = null;

const fetchCalls: Array<{
  url: string;
  init: RequestInit;
}> = [];
let fetchResponses: Array<{ ok: boolean; status: number; body: string }> = [];
let fetchCallIndex = 0;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const defaultTask: A2ATask = {
  id: "task-123",
  status: { state: "completed", timestamp: new Date().toISOString() },
  artifacts: [
    {
      artifact_id: "art-1",
      parts: [{ kind: "text", text: "Hello from assistant" }],
    },
  ],
};

mock.module("../../../../a2a/task-store.js", () => ({
  completeWithArtifacts: (taskId: string, artifacts: Artifact[]): A2ATask => {
    completeWithArtifactsCalls.push({ taskId, artifacts });
    if (completeError) throw completeError;
    return completedTask ?? defaultTask;
  },
  getPushUrl: (taskId: string): string | null => {
    return pushUrlByTaskId[taskId] ?? null;
  },
}));

// Intercept global fetch for push notification testing
const originalFetch = globalThis.fetch;

// Import the module under test AFTER mocks are set up
const { deliverA2AReply } = await import("../deliver.js");

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  completedTask = null;
  completeWithArtifactsCalls = [];
  pushUrlByTaskId = {};
  completeError = null;
  fetchCalls.length = 0;
  fetchResponses = [];
  fetchCallIndex = 0;

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init: init ?? {} });
    const responseSpec = fetchResponses[fetchCallIndex++] ?? {
      ok: true,
      status: 200,
      body: "{}",
    };
    return new Response(responseSpec.body, {
      status: responseSpec.status,
      statusText: responseSpec.ok ? "OK" : "Error",
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deliverA2AReply", () => {
  const baseCallbackUrl = "https://example.com/deliver/a2a?taskId=task-123";

  test("completes task with text artifact", async () => {
    const payload: ChannelReplyPayload = {
      chatId: "chat-1",
      text: "Hello from the assistant",
    };

    const result = await deliverA2AReply(baseCallbackUrl, payload);

    expect(result.ok).toBe(true);
    expect(completeWithArtifactsCalls).toHaveLength(1);
    expect(completeWithArtifactsCalls[0].taskId).toBe("task-123");
    expect(completeWithArtifactsCalls[0].artifacts).toHaveLength(1);
    expect(completeWithArtifactsCalls[0].artifacts[0].parts).toEqual([
      { kind: "text", text: "Hello from the assistant" },
    ]);
  });

  test("completes task with file attachments", async () => {
    const payload: ChannelReplyPayload = {
      chatId: "chat-1",
      text: "Here is a file",
      attachments: [
        {
          id: "att-1",
          filename: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          kind: "file",
          data: "data:application/pdf;base64,abc123",
        },
      ],
    };

    const result = await deliverA2AReply(baseCallbackUrl, payload);

    expect(result.ok).toBe(true);
    expect(completeWithArtifactsCalls).toHaveLength(1);
    const parts = completeWithArtifactsCalls[0].artifacts[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      kind: "text",
      text: "Here is a file",
    });
    expect(parts[1]).toEqual({
      kind: "file",
      filename: "report.pdf",
      media_type: "application/pdf",
      url: "data:application/pdf;base64,abc123",
    });
  });

  test("returns ok: false when taskId is missing from URL", async () => {
    const result = await deliverA2AReply("https://example.com/deliver/a2a", {
      chatId: "chat-1",
      text: "Hello",
    });

    expect(result.ok).toBe(false);
    expect(completeWithArtifactsCalls).toHaveLength(0);
  });

  test("completes task for a base-less (relative) callback URL", async () => {
    const result = await deliverA2AReply("/deliver/a2a?taskId=task-123", {
      chatId: "chat-1",
      text: "Hello",
    });

    expect(result.ok).toBe(true);
    expect(completeWithArtifactsCalls).toHaveLength(1);
    expect(completeWithArtifactsCalls[0].taskId).toBe("task-123");
  });

  test("returns ok: true when payload has no content", async () => {
    const result = await deliverA2AReply(baseCallbackUrl, {
      chatId: "chat-1",
    });

    expect(result.ok).toBe(true);
    expect(completeWithArtifactsCalls).toHaveLength(0);
  });

  test("returns ok: false when task completion throws", async () => {
    completeError = new Error("A2A task not found: task-123");

    const result = await deliverA2AReply(baseCallbackUrl, {
      chatId: "chat-1",
      text: "Hello",
    });

    expect(result.ok).toBe(false);
  });

  test("returns ok: false when task is already terminal", async () => {
    completeError = new Error(
      'Cannot transition task task-123 from terminal state "completed" to "completed"',
    );

    const result = await deliverA2AReply(baseCallbackUrl, {
      chatId: "chat-1",
      text: "Hello",
    });

    expect(result.ok).toBe(false);
  });

  describe("push notifications", () => {
    test("POSTs completed task to push URL", async () => {
      pushUrlByTaskId["task-123"] = "https://requester.example.com/push";
      fetchResponses = [{ ok: true, status: 200, body: "{}" }];

      const result = await deliverA2AReply(baseCallbackUrl, {
        chatId: "chat-1",
        text: "Done",
      });

      expect(result.ok).toBe(true);

      // Wait for the fire-and-forget push to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe("https://requester.example.com/push");
      expect(fetchCalls[0].init.method).toBe("POST");

      const headers = fetchCalls[0].init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/a2a+json");
      expect(headers["A2A-Version"]).toBe("1.0");
    });

    test("does not push when no push URL configured", async () => {
      const result = await deliverA2AReply(baseCallbackUrl, {
        chatId: "chat-1",
        text: "Done",
      });

      expect(result.ok).toBe(true);

      await new Promise((r) => setTimeout(r, 50));

      expect(fetchCalls).toHaveLength(0);
    });

    test("push failure does not affect delivery result", async () => {
      pushUrlByTaskId["task-123"] = "https://requester.example.com/push";
      // All retries fail with 500
      fetchResponses = Array(4).fill({
        ok: false,
        status: 500,
        body: "Internal Server Error",
      });

      const result = await deliverA2AReply(baseCallbackUrl, {
        chatId: "chat-1",
        text: "Done",
      });

      // Delivery still succeeds even though push will fail
      expect(result.ok).toBe(true);
    });

    test("stops retrying on non-retryable client error", async () => {
      pushUrlByTaskId["task-123"] = "https://requester.example.com/push";
      fetchResponses = [{ ok: false, status: 404, body: "Not Found" }];

      await deliverA2AReply(baseCallbackUrl, {
        chatId: "chat-1",
        text: "Done",
      });

      // Wait for the fire-and-forget push to settle
      await new Promise((r) => setTimeout(r, 50));

      // Should only attempt once on a 4xx (non-429) error
      expect(fetchCalls).toHaveLength(1);
    });
  });
});
