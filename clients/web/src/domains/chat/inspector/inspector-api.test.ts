/**
 * Tests for `inspector-api.ts` — primarily the 404 fallback path that
 * keeps the inspector working against older daemons that don't yet
 * expose `GET /v1/conversations/llm-context`.
 *
 * We mock the generated daemon `client` (the generated SDK functions
 * call `client.get` under the hood) so we can stage a precise sequence
 * of HTTP responses and assert request shape (URL template + path
 * params).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  LlmContextResponse,
  LLMRequestLogEntry,
} from "@vellumai/assistant-api";

interface FakeRequest {
  url: string;
  path?: Record<string, string>;
  query?: Record<string, unknown>;
}

interface FakeResponse {
  status: number;
  body?: LlmContextResponse | null;
  /** Parsed error envelope the SDK exposes as `error` on non-2xx responses. */
  error?: unknown;
}

const requests: FakeRequest[] = [];
let nextResponses: FakeResponse[] = [];
let mockMessages: Array<{ id: string }> = [];

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
      signal?: AbortSignal;
      throwOnError?: boolean;
    }) => {
      requests.push({ url, path, query });
      const next = nextResponses.shift();
      if (!next) {
        throw new Error(
          `No staged response for request to ${url} (already consumed ${requests.length})`,
        );
      }
      const response = {
        status: next.status,
        statusText: next.status === 200 ? "OK" : "Error",
        ok: next.status >= 200 && next.status < 300,
        clone(): { text: () => Promise<string> } {
          return { text: async () => "error-body" };
        },
      };
      return { data: next.body, error: next.error, response };
    },
  },
}));

mock.module("@/domains/chat/api/messages", () => ({
  fetchConversationMessages: async () => ({
    messages: mockMessages,
    seq: null,
  }),
}));

// Subject imported after mocks.
import {
  fetchConversationLlmContext,
  fetchMessageLlmContextOrThrow,
  isLlmRequestLogsDisabledError,
} from "@/domains/chat/inspector/inspector-api";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

beforeEach(() => {
  requests.length = 0;
  nextResponses = [];
  mockMessages = [];
  // Summary-view capable assistant by default; individual tests
  // override to exercise the pre-0.8.12 path.
  useAssistantIdentityStore.getState().setIdentity("test-asst", "0.8.12");
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

function staticLog(id: string, createdAt: number): LLMRequestLogEntry {
  return {
    id,
    createdAt,
    requestPayload: null,
    responsePayload: null,
  };
}

describe("fetchConversationLlmContext — happy path", () => {
  test("returns the new conversation-scoped endpoint response when available", async () => {
    const body: LlmContextResponse = {
      conversationKey: "conv-1",
      conversationId: "conv-int-1",
      conversationKind: "user",
      conversationTotalEstimatedCostUsd: 0.21,
      logs: [staticLog("log-a", 1), staticLog("log-b", 2)],
      memoryRecall: null,
      memoryV2Activation: null,
    };
    nextResponses = [{ status: 200, body }];

    const result = await fetchConversationLlmContext(
      "asst-1",
      "conv-1",
      undefined,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      "/v1/assistants/{assistant_id}/conversations/llm-context",
    );
    expect(requests[0]!.path).toEqual({ assistant_id: "asst-1" });
    expect(requests[0]!.query).toEqual({
      conversationId: "conv-1",
      view: "summary",
    });
    expect(result).toEqual(body);
  });

  test("omits view=summary for assistants older than 0.8.12", async () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.8.11");
    const body: LlmContextResponse = {
      conversationKey: "conv-1",
      conversationId: "conv-int-1",
      conversationKind: "user",
      conversationTotalEstimatedCostUsd: null,
      logs: [staticLog("log-a", 1)],
      memoryRecall: null,
      memoryV2Activation: null,
    };
    nextResponses = [{ status: 200, body }];

    await fetchConversationLlmContext("asst-1", "conv-1", undefined);

    expect(requests[0]!.query).toEqual({ conversationId: "conv-1" });
  });

  test("throws LlmContextRequestError when the new endpoint returns a non-404 error", async () => {
    nextResponses = [{ status: 500, body: null }];

    let caught: unknown;
    try {
      await fetchConversationLlmContext("asst-1", "conv-1", undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { status: number; message: string }).status).toBe(500);
    expect((caught as { name: string }).name).toBe("LlmContextRequestError");
  });

  test("surfaces the disabled code + message from the daemon error envelope", async () => {
    nextResponses = [
      {
        status: 403,
        body: null,
        error: {
          error: {
            code: "LLM_REQUEST_LOGS_DISABLED",
            message:
              "LLM request logging is disabled. Enable it to view request logs.",
          },
        },
      },
    ];

    let caught: unknown;
    try {
      await fetchConversationLlmContext("asst-1", "conv-1", undefined);
    } catch (err) {
      caught = err;
    }
    expect(isLlmRequestLogsDisabledError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(403);
    expect((caught as { code?: string }).code).toBe(
      "LLM_REQUEST_LOGS_DISABLED",
    );
    expect((caught as { message: string }).message).toContain(
      "LLM request logging is disabled",
    );
  });
});

describe("fetchConversationLlmContext — legacy fallback (404)", () => {
  test("returns the empty shape when the conversation has no messages", async () => {
    nextResponses = [{ status: 404, body: null }];
    mockMessages = [];

    const result = await fetchConversationLlmContext(
      "asst-1",
      "conv-empty",
      undefined,
    );

    expect(requests).toHaveLength(1); // only the initial new-endpoint attempt
    expect(result).toEqual({
      conversationId: "conv-empty",
      conversationKind: "user",
      conversationTotalEstimatedCostUsd: null,
      logs: [],
      memoryRecall: null,
      memoryV2Activation: null,
    });
  });

  test("fans out per-message fetches and merges logs in chronological order", async () => {
    nextResponses = [
      { status: 404, body: null }, // new endpoint absent
      // /v1/assistants/asst-1/messages/msg-1/llm-context
      {
        status: 200,
        body: {
          messageId: "msg-1",
          conversationKey: null,
          conversationId: null,
          conversationKind: "user",
          conversationTotalEstimatedCostUsd: 0.5,
          logs: [staticLog("log-b", 2), staticLog("log-a", 1)],
          memoryRecall: null,
          memoryV2Activation: null,
        },
      },
      // /v1/assistants/asst-1/messages/msg-2/llm-context
      {
        status: 200,
        body: {
          messageId: "msg-2",
          conversationKey: null,
          conversationId: null,
          conversationKind: "user",
          // Same turn returns the same logs — dedup should collapse this.
          conversationTotalEstimatedCostUsd: 0.5,
          logs: [staticLog("log-b", 2), staticLog("log-c", 3)],
          memoryRecall: null,
          memoryV2Activation: null,
        },
      },
    ];
    mockMessages = [{ id: "msg-1" }, { id: "msg-2" }];

    const result = await fetchConversationLlmContext(
      "asst-1",
      "conv-x",
      undefined,
    );

    expect(requests).toHaveLength(3);
    expect(requests[1]!.url).toBe(
      "/v1/assistants/{assistant_id}/messages/{id}/llm-context",
    );
    expect(requests[1]!.path).toEqual({
      assistant_id: "asst-1",
      id: "msg-1",
    });
    expect(requests[2]!.path).toEqual({
      assistant_id: "asst-1",
      id: "msg-2",
    });

    expect(result.conversationId).toBe("conv-x");
    expect(result.conversationKind).toBe("user");
    expect(result.conversationTotalEstimatedCostUsd).toBe(0.5);
    // Sorted ascending by createdAt; deduped on log.id.
    expect(result.logs.map((l) => l.id)).toEqual(["log-a", "log-b", "log-c"]);
  });

  test("fetches by message id and dedupes consecutive duplicates", async () => {
    nextResponses = [
      { status: 404, body: null }, // new endpoint absent
      {
        status: 200,
        body: {
          messageId: "raw-1",
          conversationKey: null,
          conversationId: null,
          conversationKind: "user",
          conversationTotalEstimatedCostUsd: null,
          logs: [],
          memoryRecall: null,
          memoryV2Activation: null,
        },
      },
      {
        status: 200,
        body: {
          messageId: "raw-2",
          conversationKey: null,
          conversationId: null,
          conversationKind: "user",
          conversationTotalEstimatedCostUsd: null,
          logs: [],
          memoryRecall: null,
          memoryV2Activation: null,
        },
      },
    ];
    mockMessages = [
      { id: "raw-1" },
      { id: "raw-2" },
      // Duplicate of #2 — should be deduped, not refetched.
      { id: "raw-2" },
    ];

    await fetchConversationLlmContext("asst-1", "conv-x", undefined);

    expect(requests).toHaveLength(3); // 1 initial + 2 per-message
    expect(requests[1]!.path).toEqual({
      assistant_id: "asst-1",
      id: "raw-1",
    });
    expect(requests[2]!.path).toEqual({
      assistant_id: "asst-1",
      id: "raw-2",
    });
  });

  test("tolerates per-message 404s without aborting the merge", async () => {
    nextResponses = [
      { status: 404, body: null }, // new endpoint absent
      // First message returns 404 — should contribute zero logs.
      { status: 404, body: null },
      {
        status: 200,
        body: {
          messageId: "msg-2",
          conversationKey: null,
          conversationId: null,
          conversationKind: "user",
          conversationTotalEstimatedCostUsd: 0.1,
          logs: [staticLog("log-only", 7)],
          memoryRecall: null,
          memoryV2Activation: null,
        },
      },
    ];
    mockMessages = [{ id: "msg-1" }, { id: "msg-2" }];

    const result = await fetchConversationLlmContext(
      "asst-1",
      "conv-x",
      undefined,
    );

    expect(result.logs.map((l) => l.id)).toEqual(["log-only"]);
    expect(result.conversationTotalEstimatedCostUsd).toBe(0.1);
  });
});

describe("fetchMessageLlmContextOrThrow — message mode", () => {
  test("hits the per-message endpoint and returns the body", async () => {
    const body: LlmContextResponse = {
      messageId: "msg-7",
      conversationKey: null,
      conversationId: null,
      conversationKind: "user",
      conversationTotalEstimatedCostUsd: 0.03,
      logs: [staticLog("log-z", 9)],
      memoryRecall: null,
      memoryV2Activation: null,
    };
    nextResponses = [{ status: 200, body }];

    const result = await fetchMessageLlmContextOrThrow(
      "asst-1",
      "msg-7",
      undefined,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      "/v1/assistants/{assistant_id}/messages/{id}/llm-context",
    );
    expect(requests[0]!.path).toEqual({
      assistant_id: "asst-1",
      id: "msg-7",
    });
    expect(result).toEqual(body);
  });

  test("throws LlmContextRequestError on non-2xx — no fallback", async () => {
    nextResponses = [{ status: 404, body: null }];

    let caught: unknown;
    try {
      await fetchMessageLlmContextOrThrow("asst-1", "missing-msg", undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { status: number }).status).toBe(404);
    expect((caught as { name: string }).name).toBe("LlmContextRequestError");
    // No fallback fetch — message mode is a hard error if the daemon
    // can't find the message.
    expect(requests).toHaveLength(1);
  });
});
