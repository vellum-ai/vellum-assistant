import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { client } from "@/generated/daemon/client.gen";
import { ApiError } from "@/utils/api-errors";

import { listConversationStarters } from "@/domains/chat/utils/conversation-starters";

// ---------------------------------------------------------------------------
// Test helpers
//
// Previous approach mocked `globalThis.fetch`, which is fragile when bun
// batches test files into shared workers — another file's fetch mock can
// leak into the HeyAPI client singleton's fallback chain
// (`options.fetch ?? _config.fetch ?? globalThis.fetch`).
//
// Instead we mock `client.get` directly.  This tests what
// `listConversationStarters` actually controls (the options it passes and
// how it processes the response) without depending on shared global state.
// ---------------------------------------------------------------------------

interface CapturedOptions {
  url: string;
  path: Record<string, string>;
  query: Record<string, string | number>;
  throwOnError: boolean;
}

function makeOkResult(body: unknown) {
  return {
    data: body,
    error: undefined,
    response: new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

function makeErrorResult(status: number, body: unknown) {
  return {
    data: undefined,
    error: body,
    response: new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

let originalGet: typeof client.get;
let capturedOptions: CapturedOptions[] = [];
let nextResult: { data: unknown; error: unknown; response: Response } | null =
  null;

beforeEach(() => {
  originalGet = client.get;
  capturedOptions = [];
  nextResult = null;

  (client as unknown as Record<string, unknown>).get = mock(
    async (options: Record<string, unknown>) => {
      capturedOptions.push({
        url: options.url as string,
        path: options.path as Record<string, string>,
        query: options.query as Record<string, string | number>,
        throwOnError: options.throwOnError as boolean,
      });
      if (!nextResult) {
        throw new Error("test setup forgot to set nextResult");
      }
      return nextResult;
    },
  );
});

afterEach(() => {
  (client as unknown as Record<string, unknown>).get = originalGet;
});

// ---------------------------------------------------------------------------
// Successful list
// ---------------------------------------------------------------------------

describe("listConversationStarters response parsing", () => {
  test("returns starters, total and status from payload", async () => {
    nextResult = makeOkResult({
      starters: [
        {
          id: "s1",
          label: "Plan a trip",
          prompt: "Help me plan a 5-day trip to Tokyo",
          category: "travel",
          batch: 0,
        },
        {
          id: "s2",
          label: "Brainstorm",
          prompt: "Brainstorm 10 ideas for a side project",
          category: null,
          batch: 1,
        },
      ],
      total: 2,
      status: "ready",
    });

    const result = await listConversationStarters("asst-1");

    expect(result.total).toBe(2);
    expect(result.status).toBe("ready");
    expect(result.starters).toHaveLength(2);
    expect(result.starters[0]!.id).toBe("s1");
    expect(result.starters[0]!.category).toBe("travel");
    expect(result.starters[1]!.category).toBeNull();
  });

  test("falls back to safe defaults when payload omits fields", async () => {
    nextResult = makeOkResult({});

    const result = await listConversationStarters("asst-1");

    expect(result.starters).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.status).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// Request parameters
// ---------------------------------------------------------------------------

describe("listConversationStarters request parameters", () => {
  test("sends default query params when none are provided", async () => {
    nextResult = makeOkResult({
      starters: [],
      total: 0,
      status: "empty",
    });

    await listConversationStarters("asst-1");

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]!.url).toBe(
      "/v1/assistants/{assistant_id}/conversation-starters",
    );
    expect(capturedOptions[0]!.path).toEqual({ assistant_id: "asst-1" });
    expect(capturedOptions[0]!.query).toEqual({
      limit: 4,
      offset: 0,
      scope_id: "default",
    });
    expect(capturedOptions[0]!.throwOnError).toBe(false);
  });

  test("forwards explicit limit, offset, and scopeId", async () => {
    nextResult = makeOkResult({
      starters: [],
      total: 0,
      status: "empty",
    });

    await listConversationStarters("asst-1", {
      limit: 8,
      offset: 12,
      scopeId: "thread-42",
    });

    expect(capturedOptions[0]!.query).toEqual({
      limit: 8,
      offset: 12,
      scope_id: "thread-42",
    });
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("listConversationStarters error handling", () => {
  test("throws ApiError with extracted message on non-OK response", async () => {
    nextResult = makeErrorResult(503, { detail: "starters unavailable" });

    let caught: unknown = null;
    try {
      await listConversationStarters("asst-1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(503);
    expect((caught as ApiError).message).toContain("starters unavailable");
  });

  test("ApiError falls back to default message when body is not JSON", async () => {
    nextResult = {
      data: undefined,
      error: "oops",
      response: new Response("oops", { status: 500 }),
    };

    let caught: unknown = null;
    try {
      await listConversationStarters("asst-1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(500);
  });
});
