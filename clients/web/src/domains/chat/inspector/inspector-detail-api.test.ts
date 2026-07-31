/**
 * Tests for `inspector-detail-api.ts` — the lazy per-call context
 * fetch. Mocks the generated daemon `client` to stage responses and
 * assert request shape, including the 404 → `null` legacy fallback.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

interface FakeRequest {
  url: string;
  path?: Record<string, string>;
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
    }: {
      url: string;
      path?: Record<string, string>;
      signal?: AbortSignal;
      throwOnError?: boolean;
    }) => {
      requests.push({ url, path });
      const next = nextResponses.shift();
      if (!next) {
        throw new Error(`No staged response for request to ${url}`);
      }
      const response = {
        status: next.status,
        statusText: next.status === 200 ? "OK" : "Error",
        ok: next.status >= 200 && next.status < 300,
        clone(): { text: () => Promise<string> } {
          return { text: async () => "error-body" };
        },
      };
      return { data: next.body, response };
    },
  },
}));

// Subject imported after mocks.
import {
  LlmCallDetailRequestError,
  llmCallDetailQueryOptions,
} from "@/domains/chat/inspector/inspector-detail-api";

beforeEach(() => {
  requests.length = 0;
  nextResponses = [];
});

function fetchDetail(assistantId: string, logId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return queryClient.fetchQuery(llmCallDetailQueryOptions(assistantId, logId));
}

describe("llmCallDetailQueryOptions", () => {
  test("returns the per-log context body on success", async () => {
    const body = {
      id: "log-1",
      createdAt: 1,
      requestPayload: null,
      responsePayload: null,
      requestSections: [{ kind: "message", role: "user", text: "hello" }],
      responseSections: [],
    };
    nextResponses = [{ status: 200, body }];

    const result = await fetchDetail("asst-1", "log-1");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      "/v1/assistants/{assistant_id}/llm-request-logs/{id}/context",
    );
    expect(requests[0]!.path).toEqual({ assistant_id: "asst-1", id: "log-1" });
    expect(result).toEqual(body);
  });

  test("resolves to null on 404 (daemon predates the endpoint)", async () => {
    nextResponses = [{ status: 404, body: null }];

    const result = await fetchDetail("asst-1", "log-1");

    expect(result).toBeNull();
  });

  test("throws LlmCallDetailRequestError on non-404 failures", async () => {
    nextResponses = [{ status: 500, body: null }];

    let caught: unknown;
    try {
      await fetchDetail("asst-1", "log-1");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LlmCallDetailRequestError);
    expect((caught as LlmCallDetailRequestError).status).toBe(500);
  });
});
