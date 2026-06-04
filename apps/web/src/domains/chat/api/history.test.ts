import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ApiError } from "@/utils/api-errors";

import {
  fetchLatestHistoryPage,
  fetchOlderHistoryPage,
} from "@/domains/chat/api/history";
import {
  __resetSnapshotSeqForTesting,
  getSnapshotSeq,
} from "@/lib/streaming/snapshot-seq";

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
  __resetSnapshotSeqForTesting();
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

  test("filters out messages with roles other than user/assistant", async () => {
    nextResponse = makeJsonResponse({
      messages: [
        { id: "m1", role: "user", ...textBody("hello") },
        { id: "m2", role: "system", ...textBody("internal") },
      ],
      hasMore: false,
      oldestTimestamp: 0,
      oldestMessageId: "m1",
    });

    const result = await fetchLatestHistoryPage("asst-1", "K");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.id).toBe("m1");
  });

  test("deduplicates duplicate message ids in a history page", async () => {
    nextResponse = makeJsonResponse({
      messages: [
        { id: "m1", role: "user", ...textBody("hello"), timestamp: 1 },
        {
          id: "m2",
          role: "assistant",
          ...textBody("partial"),
          timestamp: 2,
        },
        {
          id: "m2",
          role: "assistant",
          ...textBody("complete response"),
          timestamp: 2,
        },
      ],
      hasMore: false,
      oldestTimestamp: 1,
      oldestMessageId: "m1",
    });

    const result = await fetchLatestHistoryPage("asst-1", "K");

    expect(result.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(messageText(result.messages[1]!)).toBe("complete response");
  });
});

// ---------------------------------------------------------------------------
// Snapshot seq watermark (ATL-780)
// ---------------------------------------------------------------------------

describe("snapshot seq", () => {
  test("threads the seq from /messages and records it as the conversation baseline", async () => {
    /**
     * The daemon advertises the conversation's durably-persisted seq on
     * the snapshot; the latest page must expose it and stash it so the
     * stream-alignment consumers can read it.
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
    // AND it is recorded as the per-conversation baseline
    expect(getSnapshotSeq("K")).toBe(42);
  });

  test("treats an omitted seq (older daemon) as no baseline without crashing", async () => {
    /**
     * An older daemon predates the seq field. The client must fall back
     * to today's cold-start behavior: null seq, no recorded baseline.
     */
    // GIVEN a snapshot from a daemon that omits the seq field
    nextResponse = makeJsonResponse({
      messages: [{ id: "m1", role: "user", ...textBody("hello") }],
      hasMore: false,
    });

    // WHEN the latest page is fetched
    const result = await fetchLatestHistoryPage("asst-1", "K");

    // THEN no honest position is threaded or recorded
    expect(result.seq).toBeNull();
    expect(getSnapshotSeq("K")).toBeNull();
  });

  test("treats an explicit null seq (cold conversation) as no baseline", async () => {
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

    // THEN it is treated as no honest position
    expect(result.seq).toBeNull();
    expect(getSnapshotSeq("K")).toBeNull();
  });

  test("a null seq snapshot clears a previously recorded baseline", async () => {
    /**
     * After a daemon restart the same conversation reports null; a stale
     * baseline from before the restart must not linger.
     */
    // GIVEN a conversation with a recorded baseline
    nextResponse = makeJsonResponse({
      messages: [{ id: "m1", role: "user", ...textBody("hi") }],
      hasMore: false,
      seq: 7,
    });
    await fetchLatestHistoryPage("asst-1", "K");
    expect(getSnapshotSeq("K")).toBe(7);

    // WHEN a later snapshot reports null (daemon restarted)
    nextResponse = makeJsonResponse({
      messages: [{ id: "m1", role: "user", ...textBody("hi") }],
      hasMore: false,
      seq: null,
    });
    await fetchLatestHistoryPage("asst-1", "K");

    // THEN the stale baseline is cleared
    expect(getSnapshotSeq("K")).toBeNull();
  });

  test("older-page loads do not move the snapshot baseline", async () => {
    /**
     * Scroll-back history pages are not the authoritative snapshot, so
     * they must not overwrite the baseline set by the latest page.
     */
    // GIVEN a latest page established the baseline
    nextResponse = makeJsonResponse({
      messages: [{ id: "m1", role: "user", ...textBody("hi") }],
      hasMore: true,
      oldestTimestamp: 5,
      oldestMessageId: "m1",
      seq: 99,
    });
    await fetchLatestHistoryPage("asst-1", "K");
    expect(getSnapshotSeq("K")).toBe(99);

    // WHEN an older page is fetched (even if it echoes a seq)
    nextResponse = makeJsonResponse({
      messages: [{ id: "m0", role: "user", ...textBody("earlier") }],
      hasMore: false,
      oldestTimestamp: 0,
      oldestMessageId: "m0",
      seq: 12,
    });
    await fetchOlderHistoryPage("asst-1", "K", 5);

    // THEN the baseline still reflects the latest page
    expect(getSnapshotSeq("K")).toBe(99);
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
