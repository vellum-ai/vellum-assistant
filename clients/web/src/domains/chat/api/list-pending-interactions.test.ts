import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Tests for listConversationIdsWithPendingInteractions — the bulk helper
// used by use-attention-tracking to avoid one HTTP request per conversation.
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown): void {
  globalThis.fetch = mock(async () =>
    Response.json(body, {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

let originalFetch: typeof fetch;
let originalDocument: typeof globalThis.document;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalDocument = globalThis.document;
  // @ts-expect-error - stub document for tests
  globalThis.document = { cookie: "" };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
});

describe("listConversationIdsWithPendingInteractions", () => {
  test("returns a set of conversation keys when interactions are pending", async () => {
    mockFetch(200, {
      interactions: [
        { requestId: "req-1", conversationId: "conv-A", kind: "secret" },
        { requestId: "req-2", conversationId: "conv-B", kind: "confirmation" },
        // Same conversation twice — must dedupe via Set semantics.
        { requestId: "req-3", conversationId: "conv-A", kind: "confirmation" },
      ],
    });
    const { listConversationIdsWithPendingInteractions } = await import(
      "@/domains/chat/api/interactions"
    );
    const keys = await listConversationIdsWithPendingInteractions("asst-1");
    expect(keys.size).toBe(2);
    expect(keys.has("conv-A")).toBe(true);
    expect(keys.has("conv-B")).toBe(true);
  });

  test("returns empty set when no interactions are pending", async () => {
    mockFetch(200, { interactions: [] });
    const { listConversationIdsWithPendingInteractions } = await import(
      "@/domains/chat/api/interactions"
    );
    const keys = await listConversationIdsWithPendingInteractions("asst-1");
    expect(keys.size).toBe(0);
  });

  test("returns empty set when interactions field is missing", async () => {
    mockFetch(200, {});
    const { listConversationIdsWithPendingInteractions } = await import(
      "@/domains/chat/api/interactions"
    );
    const keys = await listConversationIdsWithPendingInteractions("asst-1");
    expect(keys.size).toBe(0);
  });

  test("issues exactly one HTTP request (no per-conversation fan-out)", async () => {
    const fetchSpy = mock(async () =>
      Response.json(
        { interactions: [] },
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    const { listConversationIdsWithPendingInteractions } = await import(
      "@/domains/chat/api/interactions"
    );
    await listConversationIdsWithPendingInteractions("asst-1");
    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls)
      .toHaveLength(1);
  });

  test("calls the bulk endpoint without a conversationKey query param", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      if (typeof input === "string") capturedUrl = input;
      else if (input instanceof URL) capturedUrl = input.toString();
      else if (input instanceof Request) capturedUrl = input.url;
      return Response.json(
        { interactions: [] },
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { listConversationIdsWithPendingInteractions } = await import(
      "@/domains/chat/api/interactions"
    );
    await listConversationIdsWithPendingInteractions("asst-1");
    expect(capturedUrl).toBeTruthy();
    expect(capturedUrl!).toContain("pending-interactions");
    expect(capturedUrl!).not.toContain("conversationKey=");
  });

  test("skips interactions without a conversationId", async () => {
    mockFetch(200, {
      interactions: [
        { requestId: "req-1", kind: "secret" }, // missing conversationId
        { requestId: "req-2", conversationId: "", kind: "secret" }, // empty
        { requestId: "req-3", conversationId: "conv-real", kind: "secret" },
      ],
    });
    const { listConversationIdsWithPendingInteractions } = await import(
      "@/domains/chat/api/interactions"
    );
    const keys = await listConversationIdsWithPendingInteractions("asst-1");
    expect(keys.size).toBe(1);
    expect(keys.has("conv-real")).toBe(true);
  });

  test("returns empty set on 4xx response (silent failure)", async () => {
    mockFetch(404, { detail: "not found" });
    const { listConversationIdsWithPendingInteractions } = await import(
      "@/domains/chat/api/interactions"
    );
    const keys = await listConversationIdsWithPendingInteractions("asst-1");
    expect(keys.size).toBe(0);
  });

  test("throws on 5xx response so callers can decide whether to retry", async () => {
    mockFetch(500, { detail: "internal error" });
    const { listConversationIdsWithPendingInteractions } = await import(
      "@/domains/chat/api/interactions"
    );
    await expect(
      listConversationIdsWithPendingInteractions("asst-1"),
    ).rejects.toThrow(/failed: 500/);
  });

  test("returns empty set when response body is not an object", async () => {
    mockFetch(200, "not-an-object");
    const { listConversationIdsWithPendingInteractions } = await import(
      "@/domains/chat/api/interactions"
    );
    const keys = await listConversationIdsWithPendingInteractions("asst-1");
    expect(keys.size).toBe(0);
  });

  test("returns empty set when interactions is not an array", async () => {
    mockFetch(200, { interactions: "broken" });
    const { listConversationIdsWithPendingInteractions } = await import(
      "@/domains/chat/api/interactions"
    );
    const keys = await listConversationIdsWithPendingInteractions("asst-1");
    expect(keys.size).toBe(0);
  });
});
