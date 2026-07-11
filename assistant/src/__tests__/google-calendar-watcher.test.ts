import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

interface RecordedRequest {
  path: string;
  query: Record<string, string>;
}

const recorded: RecordedRequest[] = [];

// Each queued response is returned in order for successive connection.request calls.
let responses: Array<{ status: number; body: unknown }> = [];
let responseIdx = 0;

const fakeConnection = {
  request: async (opts: { path: string; query?: Record<string, string> }) => {
    recorded.push({ path: opts.path, query: { ...(opts.query ?? {}) } });
    const r = responses[Math.min(responseIdx, responses.length - 1)];
    responseIdx += 1;
    return r;
  },
};

const mockResolveOAuthConnection = mock<(provider: string) => Promise<unknown>>(
  async () => fakeConnection,
);

mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: mockResolveOAuthConnection,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Import module under test after mocks
const { googleCalendarProvider } =
  await import("../watcher/providers/google-calendar.js");

// Params that Google forbids alongside syncToken (per events.list docs).
// singleEvents is NOT forbidden; it's passed in both init and incremental reqs
// so recurring events are returned as expanded instances.
const FILTER_PARAMS = [
  "timeMin",
  "timeMax",
  "orderBy",
  "q",
  "updatedMin",
] as const;

beforeEach(() => {
  recorded.length = 0;
  responses = [];
  responseIdx = 0;
});

describe("googleCalendarProvider — initial syncToken", () => {
  test("getInitialWatermark sends a no-filter request and returns the token", async () => {
    // Google withholds nextSyncToken when the request carries a filter param
    // (timeMin/timeMax/orderBy/q/...). singleEvents is not a filter and is sent
    // alongside maxResults to expand recurring events. This is the exact
    // regression that auto-disabled the watcher (5x "did not return a syncToken").
    responses = [{ status: 200, body: { items: [], nextSyncToken: "tok_1" } }];

    const watermark =
      await googleCalendarProvider.getInitialWatermark("google");

    expect(watermark).toBe("tok_1");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.query.singleEvents).toBe("true");
    for (const param of FILTER_PARAMS) {
      expect(recorded[0]!.query).not.toHaveProperty(param);
    }
  });

  test("getInitialWatermark paginates until nextSyncToken appears", async () => {
    responses = [
      { status: 200, body: { items: [], nextPageToken: "p2" } },
      { status: 200, body: { items: [], nextSyncToken: "tok_final" } },
    ];

    const watermark =
      await googleCalendarProvider.getInitialWatermark("google");

    expect(watermark).toBe("tok_final");
    expect(recorded).toHaveLength(2);
    // Page 2 must carry the pageToken and singleEvents but no filters.
    expect(recorded[1]!.query.pageToken).toBe("p2");
    expect(recorded[1]!.query.singleEvents).toBe("true");
    for (const param of FILTER_PARAMS) {
      expect(recorded[1]!.query).not.toHaveProperty(param);
    }
  });

  test("getInitialWatermark throws when the API never returns a token", async () => {
    // No nextPageToken and no nextSyncToken -> loop exits, we surface the error.
    responses = [{ status: 200, body: { items: [] } }];

    await expect(
      googleCalendarProvider.getInitialWatermark("google"),
    ).rejects.toThrow(/did not return a syncToken/i);
  });

  test("incremental sync reuses the initial request's paging params", async () => {
    // Google requires incremental syncToken requests to carry the same allowed
    // params as the initial sync. Both must send maxResults and no filters.
    responses = [
      { status: 200, body: { items: [], nextSyncToken: "tok_next" } },
    ];

    await googleCalendarProvider.fetchNew("google", "existing-token", {}, "k");

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.query.syncToken).toBe("existing-token");
    expect(recorded[0]!.query.maxResults).toBe("250");
    expect(recorded[0]!.query.singleEvents).toBe("true");
    for (const param of FILTER_PARAMS) {
      expect(recorded[0]!.query).not.toHaveProperty(param);
    }
  });

  test("fetchNew with null watermark establishes the token and returns no items", async () => {
    responses = [{ status: 200, body: { items: [], nextSyncToken: "tok_2" } }];

    const result = await googleCalendarProvider.fetchNew(
      "google",
      null,
      {},
      "watcher-key",
    );

    expect(result.items).toHaveLength(0);
    expect(result.watermark).toBe("tok_2");
    expect(recorded[0]!.query.singleEvents).toBe("true");
    for (const param of FILTER_PARAMS) {
      expect(recorded[0]!.query).not.toHaveProperty(param);
    }
  });
});

