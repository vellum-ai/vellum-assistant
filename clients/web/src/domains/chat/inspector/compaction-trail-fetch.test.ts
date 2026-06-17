/**
 * Tests for the Compaction Trail real fetcher.
 *
 * Spies on the daemon `client.get` rather than `mock.module`-ing the
 * whole SDK — keeps the module registry clean for sibling test files.
 * The generated `conversationsByIdCompactionGet` SDK function calls
 * `client.get` under the hood.
 *
 * What's pinned:
 *   - URL pattern + path params + `callId` query reach the SDK
 *     exactly so drift here would silently 404.
 *   - The abort signal is forwarded so React Query can cancel
 *     in-flight requests when the tab unmounts.
 *   - HTTP failures raise `CompactionTrailRequestError` with the
 *     status code — the Compaction tab branches on `error.status`.
 *   - Malformed payloads raise the same error type with status `0`
 *     rather than silently returning an `events: []` trail.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { client } from "@/generated/daemon/client.gen";
import type { ConversationsByIdCompactionGetResponse } from "@/generated/daemon/types.gen";

import {
  CompactionTrailRequestError,
  fetchCompactionTrail,
} from "./compaction-trail-fetch";

type CapturedGetOptions = {
  url: string;
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  signal?: AbortSignal;
};

let captured: CapturedGetOptions | null = null;
let nextGetResult: { data: unknown; error: unknown; response: Response };
const originalGet = client.get;

const SAMPLE_RESPONSE: ConversationsByIdCompactionGetResponse = {
  conversationId: "conv-abc",
  events: [
    {
      id: "compaction-1",
      createdAt: Date.parse("2026-05-26T22:19:11Z"),
      trigger: "budget",
      compacted: true,
      summaryFailed: false,
      skipReason: null,
      contextTokensBefore: 184_000,
      contextTokensAfter: 60_000,
      messagesBefore: 130,
      messagesAfter: 14,
      compactedMessages: 116,
      preservedTailMessages: 14,
      durationMs: 8_200,
      summaryModel: "claude-sonnet-4-5",
      summaryInputTokens: 3,
      summaryOutputTokens: 882,
      summaryText: "Picked up the New Conversation 404 Bug thread.",
    },
  ],
};

beforeEach(() => {
  captured = null;
  nextGetResult = {
    data: SAMPLE_RESPONSE,
    error: null,
    response: new Response(null, { status: 200 }),
  };
  client.get = mock(async (options: CapturedGetOptions) => {
    captured = options;
    return nextGetResult;
  }) as typeof client.get;
});

afterEach(() => {
  client.get = originalGet;
});

describe("fetchCompactionTrail", () => {
  test("calls the assistant route with the platform path + query params", async () => {
    await fetchCompactionTrail(
      "assistant-1",
      "conv-abc",
      "call-32",
      undefined,
    );

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(
      "/v1/assistants/{assistant_id}/conversations/{id}/compaction",
    );
    expect(captured!.path).toEqual({
      assistant_id: "assistant-1",
      id: "conv-abc",
    });
    expect(captured!.query).toEqual({ callId: "call-32" });
  });

  test("forwards the abort signal so React Query can cancel", async () => {
    const controller = new AbortController();
    await fetchCompactionTrail(
      "assistant-1",
      "conv-abc",
      "call-32",
      controller.signal,
    );
    expect(captured!.signal).toBe(controller.signal);
  });

  test("resolves with the response body on a 200", async () => {
    const result = await fetchCompactionTrail(
      "assistant-1",
      "conv-abc",
      "call-32",
      undefined,
    );
    expect(result.conversationId).toBe("conv-abc");
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("compaction-1");
  });

  test("throws CompactionTrailRequestError with the HTTP status on non-OK", async () => {
    nextGetResult = {
      data: null,
      error: { detail: "not found" },
      response: new Response(null, { status: 404 }),
    };

    try {
      await fetchCompactionTrail(
        "assistant-1",
        "conv-abc",
        "call-32",
        undefined,
      );
      throw new Error("expected fetchCompactionTrail to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CompactionTrailRequestError);
      expect((err as CompactionTrailRequestError).status).toBe(404);
    }
  });

  test("throws CompactionTrailRequestError(0) when the body is malformed", async () => {
    nextGetResult = {
      data: { conversationId: "conv-abc" }, // missing `events`
      error: null,
      response: new Response(null, { status: 200 }),
    };

    try {
      await fetchCompactionTrail(
        "assistant-1",
        "conv-abc",
        "call-32",
        undefined,
      );
      throw new Error("expected fetchCompactionTrail to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CompactionTrailRequestError);
      expect((err as CompactionTrailRequestError).status).toBe(0);
    }
  });
});
