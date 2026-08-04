/**
 * Drain diagnostics and telemetry for the conversation-list fetchers.
 *
 * The ring holds 200 entries, so a multi-page drain must contribute a bounded
 * handful of them: the first page (the request that gates first paint), one
 * summary, and one entry per failed page. These tests pin that budget, plus
 * the one aggregate watchdog event each drain puts on the telemetry rail.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { getDiagnosticsEvents, type DiagnosticsEvent } from "@/lib/diagnostics";
import { ApiError } from "@/utils/api-errors";
import type { RawConversationSummary } from "@/utils/conversation-transforms";

const emitClientPerfEventMock = mock(
  (_checkName: string, _value: number, _detail?: Record<string, unknown>) => {},
);

mock.module("@/lib/telemetry/client-perf", () => ({
  emitClientPerfEvent: emitClientPerfEventMock,
}));

const {
  listArchivedConversations,
  listBackgroundConversations,
  listConversations,
  listOriginChannelConversations,
  listScheduledConversations,
} = await import("@/utils/conversation-list-fetchers");

const ASSISTANT_ID = "assistant-1";

function makeRaw(id: string): RawConversationSummary {
  return {
    id,
    title: "",
    createdAt: 0,
    updatedAt: 0,
    lastMessageAt: 0,
    conversationType: "standard",
    source: "vellum",
    groupId: "",
    isProcessing: false,
  } as RawConversationSummary;
}

type PageFixture = {
  ids: string[];
  hasMore: boolean;
  status?: number;
  contentLength?: string;
};

/**
 * Stub the daemon transport so each list GET resolves the next fixture in
 * order. Returns the captured offsets so tests can assert the walk.
 */
function stubPages(fixtures: PageFixture[]): { offsets: number[] } {
  const offsets: number[] = [];
  daemonClient.get = mock(
    async (options: { query?: Record<string, unknown> }) => {
      const index = offsets.length;
      offsets.push(Number(options.query?.offset ?? 0));
      const fixture = fixtures[index];
      if (!fixture) {
        throw new Error(`test setup has no fixture for request ${index}`);
      }
      const status = fixture.status ?? 200;
      const body = {
        conversations: fixture.ids.map(makeRaw),
        hasMore: fixture.hasMore,
      };
      return {
        data: status === 200 ? body : null,
        error: status === 200 ? null : { message: "boom" },
        response: new Response(JSON.stringify(body), {
          status,
          headers: fixture.contentLength
            ? { "content-length": fixture.contentLength }
            : {},
        }),
      };
    },
  ) as typeof daemonClient.get;
  return { offsets };
}

/**
 * Run `run` and return its result alongside the diagnostics it recorded. The
 * ring is process-wide and has no reset hook, so each case slices from the
 * length it observed rather than clearing.
 */
async function diagnosticsDuring<T>(
  run: () => Promise<T>,
): Promise<{ result: T; events: DiagnosticsEvent[] }> {
  const baseline = getDiagnosticsEvents().length;
  const result = await run();
  return { result, events: getDiagnosticsEvents().slice(baseline) };
}

/** The `client_list.drain` emits recorded since the last reset. */
function drainEmits(): Array<{
  value: number;
  detail: Record<string, unknown>;
}> {
  return emitClientPerfEventMock.mock.calls
    .filter(([checkName]) => checkName === "client_list.drain")
    .map(([, value, detail]) => ({ value, detail: detail ?? {} }));
}

const originalGet = daemonClient.get;

afterEach(() => {
  daemonClient.get = originalGet;
  emitClientPerfEventMock.mockClear();
});

describe("conversation list drain diagnostics", () => {
  test("a 3-page drain records the first page and one summary, not one per page", async () => {
    const { offsets } = stubPages([
      { ids: ["c-0", "c-1"], hasMore: true, contentLength: "100" },
      { ids: ["c-2", "c-1"], hasMore: true, contentLength: "200" },
      { ids: ["c-3"], hasMore: false, contentLength: "50" },
    ]);

    const { result: conversations, events } = await diagnosticsDuring(() =>
      listConversations(ASSISTANT_ID),
    );

    expect(offsets).toEqual([0, 50, 100]);
    expect(conversations).toHaveLength(4);

    expect(events.map((e) => e.kind)).toEqual([
      "conversation_list_page_fetch",
      "conversation_list_drain",
    ]);

    expect(events[0]?.details).toMatchObject({
      assistantId: ASSISTANT_ID,
      offset: 0,
      status: 200,
      count: 2,
      hasMore: true,
      bytes: 100,
    });

    expect(events[1]?.details).toMatchObject({
      assistantId: ASSISTANT_ID,
      outcome: "ok",
      pages: 3,
      // Deduped: "c-1" appears on both page 0 and page 1.
      rows: 4,
      totalBytes: 350,
      conversationType: null,
    });
  });

  test("a failing page records a page error plus an error summary and rethrows", async () => {
    const { offsets } = stubPages([
      { ids: ["c-0"], hasMore: true, contentLength: "100" },
      { ids: [], hasMore: false, status: 500 },
    ]);

    let thrown: unknown;
    const { events } = await diagnosticsDuring(() =>
      listConversations(ASSISTANT_ID).catch((error: unknown) => {
        thrown = error;
      }),
    );

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(500);
    expect(offsets).toEqual([0, 50]);

    expect(events.map((e) => e.kind)).toEqual([
      "conversation_list_page_fetch",
      "conversation_list_page_fetch_error",
      "conversation_list_drain",
    ]);

    expect(events[1]?.details).toMatchObject({
      assistantId: ASSISTANT_ID,
      offset: 50,
      status: 500,
      conversationType: null,
      archiveStatus: null,
    });

    expect(events[2]?.details).toMatchObject({
      outcome: "error",
      // Only the page that resolved counts toward the drain.
      pages: 1,
      rows: 1,
      totalBytes: 100,
    });
  });

  test("bytes is null when content-length is absent and numeric when present", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false }]);
    const withoutHeader = await diagnosticsDuring(() =>
      listConversations(ASSISTANT_ID),
    );

    expect(withoutHeader.events[0]?.details.bytes).toBeNull();
    expect(withoutHeader.events[1]?.details.totalBytes).toBeNull();

    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "4096" }]);
    const withHeader = await diagnosticsDuring(() =>
      listConversations(ASSISTANT_ID),
    );

    expect(withHeader.events[0]?.details.bytes).toBe(4096);
    expect(withHeader.events[1]?.details.totalBytes).toBe(4096);
  });

  test("every recorded detail value is a scalar or null", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "10" }]);

    const { events } = await diagnosticsDuring(() =>
      listConversations(ASSISTANT_ID),
    );

    expect(events).toHaveLength(2);
    for (const event of events) {
      for (const value of Object.values(event.details)) {
        if (value === null) {
          continue;
        }
        expect(["string", "number", "boolean"]).toContain(typeof value);
      }
    }
    expect(typeof events[0]?.details.durationMs).toBe("number");
    expect(typeof events[1]?.details.maxPageMs).toBe("number");
  });
});

describe("conversation list drain telemetry", () => {
  test("a 3-page drain emits one client_list.drain, not one per page", async () => {
    stubPages([
      { ids: ["c-0"], hasMore: true, contentLength: "100" },
      { ids: ["c-1"], hasMore: true, contentLength: "200" },
      { ids: ["c-2"], hasMore: false, contentLength: "50" },
    ]);

    await listConversations(ASSISTANT_ID);

    expect(emitClientPerfEventMock.mock.calls).toHaveLength(1);
    const emits = drainEmits();
    expect(emits).toHaveLength(1);
    expect(typeof emits[0]?.value).toBe("number");
    expect(emits[0]?.detail).toEqual({
      outcome: "ok",
      pages: "3",
      rows: "3",
      max_page_ms: expect.any(String),
      total_bytes: "350",
      list_kind: "foreground",
    });
  });

  test("a background drain reports its own list_kind", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "10" }]);

    await listBackgroundConversations(ASSISTANT_ID);

    const emits = drainEmits();
    expect(emits).toHaveLength(1);
    expect(emits[0]?.detail).toMatchObject({
      outcome: "ok",
      pages: "1",
      list_kind: "background",
    });
  });

  test("a scheduled drain reports its own list_kind", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "10" }]);

    await listScheduledConversations(ASSISTANT_ID);

    const emits = drainEmits();
    expect(emits).toHaveLength(1);
    expect(emits[0]?.detail).toMatchObject({ list_kind: "scheduled" });
  });

  test("an origin-channel drain is labeled origin_channel, not foreground", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "10" }]);

    await listOriginChannelConversations(ASSISTANT_ID, "slack");

    const emits = drainEmits();
    expect(emits).toHaveLength(1);
    expect(emits[0]?.detail).toMatchObject({
      outcome: "ok",
      pages: "1",
      list_kind: "origin_channel",
    });
  });

  test("both archive-page drains are labeled archived, not foreground or background", async () => {
    // The archive page drains the foreground and background buckets in
    // parallel, so one call produces two emits.
    stubPages([
      { ids: ["c-0"], hasMore: false, contentLength: "10" },
      { ids: ["c-1"], hasMore: false, contentLength: "20" },
    ]);

    await listArchivedConversations(ASSISTANT_ID);

    const emits = drainEmits();
    expect(emits).toHaveLength(2);
    expect(emits.map((emit) => emit.detail.list_kind)).toEqual([
      "archived",
      "archived",
    ]);
  });

  test("the detail bag carries no assistant id, and unknown bytes when content-length is absent", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false }]);

    await listConversations(ASSISTANT_ID);

    const emits = drainEmits();
    expect(emits).toHaveLength(1);
    const detail = emits[0]!.detail;
    for (const key of Object.keys(detail)) {
      expect(key.toLowerCase()).not.toContain("assistant");
    }
    expect(Object.values(detail)).not.toContain(ASSISTANT_ID);
    expect(detail.total_bytes).toBe("unknown");
  });

  test("a failing drain emits outcome error and still rethrows", async () => {
    stubPages([
      { ids: ["c-0"], hasMore: true, contentLength: "100" },
      { ids: [], hasMore: false, status: 500 },
    ]);

    let thrown: unknown;
    await listConversations(ASSISTANT_ID).catch((error: unknown) => {
      thrown = error;
    });

    expect(thrown).toBeInstanceOf(ApiError);
    const emits = drainEmits();
    expect(emits).toHaveLength(1);
    expect(emits[0]?.detail).toMatchObject({
      outcome: "error",
      pages: "1",
      rows: "1",
      list_kind: "foreground",
    });
  });
});
