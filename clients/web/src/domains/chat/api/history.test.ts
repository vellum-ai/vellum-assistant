import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ApiError } from "@/utils/api-errors";

import {
  fetchLatestHistoryPage,
  fetchOlderHistoryPage,
} from "@/domains/chat/api/history";

import {
  messageText,
  textBody,
} from "@/domains/chat/utils/message-test-helpers";
// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function makeJsonResponse(
  body: unknown,
  init: { status?: number } = {},
): Response {
  const status = init.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let originalFetch: typeof fetch;
let captured: CapturedRequest[] = [];
let nextResponse: Response | Promise<Response> | null = null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  captured = [];
  nextResponse = null;
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    captured.push({ url, init });
    if (!nextResponse) {
      throw new Error("test setup forgot to set nextResponse");
    }
    return Promise.resolve(nextResponse);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

describe("fetchLatestHistoryPage URL construction", () => {
  test("builds the correct URL with conversationId, page=latest, and limit", async () => {
    nextResponse = makeJsonResponse({
      messages: [],
      hasMore: false,
      oldestTimestamp: null,
      oldestMessageId: null,
    });

    await fetchLatestHistoryPage("asst-1", "K");

    expect(captured).toHaveLength(1);
    const url = new URL(captured[0]!.url, "http://localhost");
    expect(url.pathname).toBe("/v1/assistants/asst-1/messages");
    expect(url.searchParams.get("conversationId")).toBe("K");
    expect(url.searchParams.get("conversationKey")).toBeNull();
    expect(url.searchParams.get("page")).toBe("latest");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  test("honours a custom limit", async () => {
    nextResponse = makeJsonResponse({
      messages: [],
      hasMore: false,
      oldestTimestamp: null,
      oldestMessageId: null,
    });

    await fetchLatestHistoryPage("asst-1", "K", 25);

    const url = new URL(captured[0]!.url, "http://localhost");
    expect(url.searchParams.get("limit")).toBe("25");
  });
});

describe("fetchOlderHistoryPage URL construction", () => {
  test("builds the correct URL with conversationId, beforeTimestamp, and limit", async () => {
    nextResponse = makeJsonResponse({
      messages: [],
      hasMore: false,
      oldestTimestamp: null,
      oldestMessageId: null,
    });

    await fetchOlderHistoryPage("asst-1", "K", 1_700_000_000_000);

    expect(captured).toHaveLength(1);
    const url = new URL(captured[0]!.url, "http://localhost");
    expect(url.pathname).toBe("/v1/assistants/asst-1/messages");
    expect(url.searchParams.get("conversationId")).toBe("K");
    expect(url.searchParams.get("conversationKey")).toBeNull();
    expect(url.searchParams.get("beforeTimestamp")).toBe("1700000000000");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("page")).toBeNull();
  });

  test("honours a custom limit", async () => {
    nextResponse = makeJsonResponse({
      messages: [],
      hasMore: false,
      oldestTimestamp: null,
      oldestMessageId: null,
    });

    await fetchOlderHistoryPage("asst-1", "K", 1_700_000_000_000, 10);

    const url = new URL(captured[0]!.url, "http://localhost");
    expect(url.searchParams.get("limit")).toBe("10");
  });
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

describe("response parsing", () => {
  test("returns messages with ids and all pagination cursors", async () => {
    nextResponse = makeJsonResponse({
      messages: [
        { id: "m1", role: "user", ...textBody("hello"), timestamp: 1 },
        { id: "m2", role: "assistant", ...textBody("hi"), timestamp: 2 },
      ],
      hasMore: true,
      oldestTimestamp: 1,
      oldestMessageId: "m1",
    });

    const result = await fetchLatestHistoryPage("asst-1", "K");

    expect(result.hasMore).toBe(true);
    expect(result.oldestTimestamp).toBe(1);
    expect(result.oldestMessageId).toBe("m1");
    expect(result.messages).toHaveLength(2);
    for (const msg of result.messages) {
      expect(typeof msg.id).toBe("string");
      expect(msg.id!.length).toBeGreaterThan(0);
    }
    // ids are unique across messages in the same page
    const ids = result.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    expect(result.messages[0]!.role).toBe("user");
    expect(messageText(result.messages[0]!)).toBe("hello");
    expect(result.messages[1]!.role).toBe("assistant");
    expect(messageText(result.messages[1]!)).toBe("hi");
  });

  test("older-page response is parsed the same way", async () => {
    nextResponse = makeJsonResponse({
      messages: [
        { id: "m0", role: "user", ...textBody("earlier"), timestamp: 0 },
      ],
      hasMore: false,
      oldestTimestamp: 0,
      oldestMessageId: "m0",
    });

    const result = await fetchOlderHistoryPage("asst-1", "K", 100);

    expect(result.hasMore).toBe(false);
    expect(result.oldestTimestamp).toBe(0);
    expect(result.oldestMessageId).toBe("m0");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.id).toBeTruthy();
  });

  test("falls back to null when oldestTimestamp/oldestMessageId are omitted", async () => {
    nextResponse = makeJsonResponse({
      messages: [{ id: "m1", role: "user", ...textBody("hello") }],
      hasMore: false,
    });

    const latest = await fetchLatestHistoryPage("asst-1", "K");
    expect(latest.oldestTimestamp).toBeNull();
    expect(latest.oldestMessageId).toBeNull();

    nextResponse = makeJsonResponse({
      messages: [{ id: "m1", role: "user", ...textBody("hello") }],
      hasMore: false,
    });
    const older = await fetchOlderHistoryPage("asst-1", "K", 100);
    expect(older.oldestTimestamp).toBeNull();
    expect(older.oldestMessageId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Snapshot seq watermark (ATL-780)
// ---------------------------------------------------------------------------

describe("snapshot seq threading", () => {
  test("threads the seq from /messages onto the latest-page result", async () => {
    /**
     * The daemon advertises the conversation's durably-persisted seq on
     * the snapshot; the latest page must surface it so the accept-point
     * caller can record it as the conversation baseline. Recording is the
     * caller's job (after its stale-response guard), not the fetcher's.
     */
    // GIVEN a latest-page snapshot that reports a persisted seq
    nextResponse = makeJsonResponse({
      messages: [{ id: "m1", role: "user", ...textBody("hello") }],
      hasMore: false,
      seq: 42,
    });

    // WHEN the latest page is fetched
    const result = await fetchLatestHistoryPage("asst-1", "K");

    // THEN the result carries the seq
    expect(result.seq).toBe(42);
  });

  test("threads null when the daemon omits the seq field (older daemon)", async () => {
    /**
     * An older daemon predates the seq field. The result reports null so
     * the caller falls back to today's cold-start behavior.
     */
    // GIVEN a snapshot from a daemon that omits the seq field
    nextResponse = makeJsonResponse({
      messages: [{ id: "m1", role: "user", ...textBody("hello") }],
      hasMore: false,
    });

    // WHEN the latest page is fetched
    const result = await fetchLatestHistoryPage("asst-1", "K");

    // THEN no honest position is threaded
    expect(result.seq).toBeNull();
  });

  test("threads null when the daemon reports an explicit null seq", async () => {
    /**
     * The daemon returns null when nothing has been persisted in-process
     * (cold conversation, post-restart, aged-out map).
     */
    // GIVEN a snapshot that explicitly reports a null seq
    nextResponse = makeJsonResponse({
      messages: [],
      hasMore: false,
      seq: null,
    });

    // WHEN the latest page is fetched
    const result = await fetchLatestHistoryPage("asst-1", "K");

    // THEN it is threaded as no honest position
    expect(result.seq).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Subagent notification extraction
// ---------------------------------------------------------------------------

describe("subagent notification extraction", () => {
  test("extracts subagentNotification objects from history messages", async () => {
    /**
     * History messages carry subagentNotification metadata that the UI uses
     * to reconstruct subagent state on reload.
     */
    nextResponse = makeJsonResponse({
      messages: [
        { id: "m1", role: "user", ...textBody("hello") },
        {
          id: "m2",
          role: "assistant",
          ...textBody("[Subagent spawned]"),
          subagentNotification: {
            subagentId: "sa-1",
            label: "Research Agent",
            status: "completed",
            conversationId: "conv-abc",
          },
        },
      ],
      hasMore: false,
      oldestTimestamp: 0,
      oldestMessageId: "m1",
    });

    const result = await fetchLatestHistoryPage("asst-1", "K");

    expect(result.subagentNotifications).toHaveLength(1);
    expect(result.subagentNotifications![0]!.subagentId).toBe("sa-1");
    expect(result.subagentNotifications![0]!.status).toBe("completed");
    expect(result.subagentNotifications![0]!.conversationId).toBe("conv-abc");
  });

  test("extracts multiple notifications for the same subagent (dedup happens upstream)", async () => {
    /**
     * The daemon may inject multiple notifications for the same subagent
     * (e.g. a "running" notification when blocked, then a "completed" one).
     * The parser extracts all of them; deduplication is handled by the consumer.
     */
    nextResponse = makeJsonResponse({
      messages: [
        {
          id: "m1",
          role: "assistant",
          ...textBody("[Subagent blocked]"),
          subagentNotification: {
            subagentId: "sa-1",
            label: "Arizona Tea Research",
            status: "running",
            conversationId: "conv-abc",
          },
        },
        {
          id: "m2",
          role: "assistant",
          ...textBody("[Subagent completed]"),
          subagentNotification: {
            subagentId: "sa-1",
            label: "Arizona Tea Research",
            status: "completed",
            conversationId: "conv-abc",
          },
        },
      ],
      hasMore: false,
      oldestTimestamp: 0,
      oldestMessageId: "m1",
    });

    const result = await fetchLatestHistoryPage("asst-1", "K");

    // THEN both notifications are extracted in chronological order
    expect(result.subagentNotifications).toHaveLength(2);
    expect(result.subagentNotifications![0]!.status).toBe("running");
    expect(result.subagentNotifications![1]!.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Background-tool completion extraction
// ---------------------------------------------------------------------------

describe("background-tool completion extraction", () => {
  test("projects a backgroundToolCompletion row onto backgroundToolCompletions, preserving the id exactly", async () => {
    /**
     * A history row that carries a `backgroundToolCompletion` record yields a
     * `BackgroundTaskEntry` with the wire fields mapped 1:1. The `id` must be
     * preserved verbatim: web background-card detection keys off the spawning
     * tool result's `bg-…` id, so the seeded entry's id has to equal it.
     */
    nextResponse = makeJsonResponse({
      messages: [
        { id: "m1", role: "user", ...textBody("run it") },
        {
          id: "m2",
          role: "assistant",
          ...textBody("[Background task completed]"),
          backgroundToolCompletion: {
            id: "bg-abcd1234",
            toolName: "bash",
            conversationId: "conv-xyz",
            command: "sleep 5 && echo done",
            startedAt: 1000,
            status: "completed",
            exitCode: 0,
            output: "done\n",
            completedAt: 6000,
          },
        },
      ],
      hasMore: false,
      oldestTimestamp: 0,
      oldestMessageId: "m1",
    });

    const result = await fetchLatestHistoryPage("asst-1", "K");

    expect(result.backgroundToolCompletions).toEqual([
      {
        id: "bg-abcd1234",
        toolName: "bash",
        conversationId: "conv-xyz",
        command: "sleep 5 && echo done",
        startedAt: 1000,
        status: "completed",
        exitCode: 0,
        output: "done\n",
        completedAt: 6000,
      },
    ]);
    expect(result.backgroundToolCompletions![0]!.id).toBe("bg-abcd1234");
  });

  test("yields an empty array when no row carries a completion", async () => {
    nextResponse = makeJsonResponse({
      messages: [
        { id: "m1", role: "user", ...textBody("hello") },
        { id: "m2", role: "assistant", ...textBody("hi") },
      ],
      hasMore: false,
      oldestTimestamp: 0,
      oldestMessageId: "m1",
    });

    const result = await fetchLatestHistoryPage("asst-1", "K");

    expect(result.backgroundToolCompletions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  test("fetchLatestHistoryPage rejects with ApiError on non-2xx response", async () => {
    nextResponse = makeJsonResponse({ detail: "boom" }, { status: 500 });

    await expect(fetchLatestHistoryPage("asst-1", "K")).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  test("fetchOlderHistoryPage rejects with ApiError on non-2xx response", async () => {
    nextResponse = makeJsonResponse({ detail: "not found" }, { status: 404 });

    let caught: unknown = null;
    try {
      await fetchOlderHistoryPage("asst-1", "K", 123);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).message).toContain("not found");
  });

  test("ApiError message falls back to HTTP status when body is not JSON", async () => {
    nextResponse = new Response("oops", { status: 502 });

    let caught: unknown = null;
    try {
      await fetchLatestHistoryPage("asst-1", "K");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(502);
  });
});
