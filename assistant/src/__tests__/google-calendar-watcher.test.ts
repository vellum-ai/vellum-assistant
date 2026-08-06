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
const { WATCHER_PAYLOAD_TEXT_MAX_CHARS } =
  await import("../watcher/constants.js");
const { capPayloadForStorage } = await import("../watcher/payload-bounds.js");

// Params that must NOT appear on the sync-token stream. timeMin/timeMax/
// orderBy/q/updatedMin are forbidden alongside syncToken (per events.list docs)
// and also cause Google to withhold nextSyncToken. singleEvents is not
// forbidden, but is deliberately omitted so the stream stays collapsed — a
// recurring-series change surfaces as one parent event instead of one event per
// expanded instance. Instances are expanded only in the bounded display query.
const FILTER_PARAMS = [
  "timeMin",
  "timeMax",
  "orderBy",
  "q",
  "updatedMin",
  "singleEvents",
] as const;

beforeEach(() => {
  recorded.length = 0;
  responses = [];
  responseIdx = 0;
});

describe("googleCalendarProvider — initial syncToken", () => {
  test("getInitialWatermark sends a no-filter request and returns the token", async () => {
    // Google withholds nextSyncToken when the request carries a filter param
    // (timeMin/timeMax/orderBy/q/...). The stream also omits singleEvents to
    // stay collapsed. This is the exact regression that auto-disabled the
    // watcher (5x "did not return a syncToken").
    responses = [{ status: 200, body: { items: [], nextSyncToken: "tok_1" } }];

    const watermark =
      await googleCalendarProvider.getInitialWatermark("google");

    expect(watermark).toBe("tok_1");
    expect(recorded).toHaveLength(1);
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
    // Page 2 must carry the pageToken but no filters (and no singleEvents).
    expect(recorded[1]!.query.pageToken).toBe("p2");
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
    for (const param of FILTER_PARAMS) {
      expect(recorded[0]!.query).not.toHaveProperty(param);
    }
  });

  test("expired syncToken falls back to a bounded, expanded display query", async () => {
    // The collapsed sync stream is the counterpart to an expanded DISPLAY query:
    // when the syncToken expires (410), we fall back to listing upcoming events
    // with singleEvents=true AND a timeMin window, so instances are expanded but
    // bounded. This guards the "collapsed stream / expanded bounded display"
    // contract from regressing back to expanding the unbounded sync stream.
    responses = [
      { status: 410, body: { error: "sync token expired" } },
      { status: 200, body: { items: [] } },
    ];

    await googleCalendarProvider.fetchNew("google", "stale-token", {}, "k");

    // First call is the failed incremental sync (collapsed: no timeMin, no
    // singleEvents). The subsequent fallback display query is the one that
    // carries timeMin — identify it by that rather than a positional index,
    // since listEvents may paginate.
    const syncCall = recorded[0]!.query;
    expect(syncCall.syncToken).toBe("stale-token");
    expect(syncCall).not.toHaveProperty("timeMin");
    expect(syncCall).not.toHaveProperty("singleEvents");

    const fallback = recorded.find((r) => "timeMin" in r.query)?.query;
    expect(fallback).toBeDefined();
    expect(fallback!.singleEvents).toBe("true");
    expect(fallback!.orderBy).toBe("startTime");
  });
});

// ── Payload bounds (LUM-2925) ─────────────────────────────────────────

describe("googleCalendarProvider: payload bounds", () => {
  function syncResponseWithEvent(description: string) {
    return [
      {
        status: 200,
        body: {
          items: [
            {
              id: "evt-1",
              status: "confirmed",
              summary: "Quarterly review",
              description,
              start: { dateTime: "2026-08-01T10:00:00Z" },
              end: { dateTime: "2026-08-01T11:00:00Z" },
              created: "2026-07-01T00:00:00Z",
              updated: "2026-07-02T00:00:00Z",
            },
          ],
          nextSyncToken: "tok_after",
        },
      },
    ];
  }

  test("an oversized description is bounded before it can be stored", async () => {
    // The provider hands the field over as the API returned it. The engine runs
    // `capPayloadForStorage` over the whole payload before Phase 1 serializes it
    // into `watcher_events.payload_json`, which is what bounds the stored row
    // and the `watcher_list` / `watcher_digest` responses built from it. Doing
    // it there covers `location` and every other free-text field, on every
    // provider, without each one naming its own. `engine.test.ts` covers the
    // wiring; this covers what that pass does to a real calendar payload.
    responses = syncResponseWithEvent("D".repeat(50_000));

    const result = await googleCalendarProvider.fetchNew(
      "google",
      "tok_before",
      {},
      "k",
    );

    expect(result.items).toHaveLength(1);
    const stored = JSON.parse(
      JSON.stringify(capPayloadForStorage(result.items[0]!.payload)),
    );
    expect(stored.description.length).toBe(WATCHER_PAYLOAD_TEXT_MAX_CHARS);
    // Bounding truncates, it does not drop the field.
    expect(stored.description.startsWith("D".repeat(1_000))).toBe(true);
  });

  test("a normal description passes through unchanged and unfenced", async () => {
    // The engine wraps the whole rendered event block in one
    // <external_content> envelope, so a per-field wrapper here would only nest
    // an escaped fence inside that one.
    responses = syncResponseWithEvent("Bring the Q3 deck.");

    const result = await googleCalendarProvider.fetchNew(
      "google",
      "tok_before",
      {},
      "k",
    );

    expect(result.items[0]!.payload.description).toBe("Bring the Q3 deck.");
    expect(JSON.stringify(result.items[0]!.payload)).not.toContain(
      "external_content",
    );
  });
});
