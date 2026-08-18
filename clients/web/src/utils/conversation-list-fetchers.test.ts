/**
 * Drain diagnostics and telemetry for the conversation-list fetchers.
 *
 * The ring holds 200 entries, so a multi-page drain must contribute a bounded
 * handful of them: the first page (the request that gates first paint), one
 * summary, and one entry per failed page. These tests pin that budget, plus
 * the one aggregate watchdog event each drain puts on the telemetry rail and
 * the single entry each standalone first-page fetch contributes.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { getDiagnosticsEvents, type DiagnosticsEvent } from "@/lib/diagnostics";
import { ApiError } from "@/utils/api-errors";
import {
  ARCHIVED_BACKGROUND_FILTER,
  ARCHIVED_FILTER,
  BACKGROUND_FILTER,
  SCHEDULED_FILTER,
} from "@/utils/conversation-list-keys";
import type { RawConversationSummary } from "@/utils/conversation-transforms";

const emitClientPerfEventMock = mock(
  (_checkName: string, _value: number, _detail?: Record<string, unknown>) => {},
);

// `mock.module` replaces the module process-wide, so it has to stand in for the
// full export surface or an unrelated importer picks up an undefined binding.
mock.module("@/lib/telemetry/client-perf", () => ({
  emitClientPerfEvent: emitClientPerfEventMock,
  setClientPerfBootId: () => {},
  __resetClientPerfForTests: () => {},
}));

const {
  drainConversationList,
  hasAnyActiveConversation,
  listConversationsFirstPage,
  listConversationsPage,
} = await import("@/utils/conversation-list-fetchers");

/** The archive view's two drains, as its hook issues them. */
function drainArchived(): Promise<unknown> {
  return Promise.all([
    drainConversationList(ASSISTANT_ID, ARCHIVED_FILTER),
    drainConversationList(ASSISTANT_ID, ARCHIVED_BACKGROUND_FILTER),
  ]);
}

const ASSISTANT_ID = "assistant-1";

function makeRaw(id: string, lastMessageAt = 0): RawConversationSummary {
  return {
    id,
    title: "",
    createdAt: 0,
    updatedAt: 0,
    lastMessageAt,
    conversationType: "standard",
    source: "vellum",
    groupId: "",
    isProcessing: false,
  } as RawConversationSummary;
}

type PageFixture = {
  /** Row ids, or `[id, lastMessageAt]` where a test's logic needs recency. */
  ids: Array<string | [string, number]>;
  hasMore: boolean;
  status?: number;
  contentLength?: string;
};

/**
 * Stub the daemon transport so each list GET resolves the next fixture in
 * order. Returns the captured offsets so tests can assert the walk.
 */
function stubPages(fixtures: PageFixture[]): {
  offsets: number[];
  queries: Record<string, unknown>[];
} {
  const offsets: number[] = [];
  const queries: Record<string, unknown>[] = [];
  daemonClient.get = mock(
    async (options: { query?: Record<string, unknown> }) => {
      const index = offsets.length;
      offsets.push(Number(options.query?.offset ?? 0));
      queries.push({ ...(options.query ?? {}) });
      const fixture = fixtures[index];
      if (!fixture) {
        throw new Error(`test setup has no fixture for request ${index}`);
      }
      const status = fixture.status ?? 200;
      const ok = status < 400;
      const body = {
        conversations: fixture.ids.map((entry) =>
          typeof entry === "string" ? makeRaw(entry) : makeRaw(...entry),
        ),
        hasMore: fixture.hasMore,
      };
      return {
        data: ok ? body : null,
        error: ok ? null : { message: "boom" },
        response: new Response(JSON.stringify(body), {
          status,
          headers:
            fixture.contentLength === undefined
              ? {}
              : { "content-length": fixture.contentLength },
        }),
      };
    },
  ) as typeof daemonClient.get;
  return { offsets, queries };
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
      drainConversationList(ASSISTANT_ID),
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
      listKind: "foreground",
      source: "drain",
    });
    expect(events[0]?.details).not.toHaveProperty("conversationType");

    expect(events[1]?.details).toMatchObject({
      assistantId: ASSISTANT_ID,
      outcome: "ok",
      pages: 3,
      // Deduped: "c-1" appears on both page 0 and page 1.
      rows: 4,
      totalBytes: 350,
      listKind: "foreground",
    });
    expect(events[1]?.details).not.toHaveProperty("conversationType");
  });

  test("a failing page records a page error plus an error summary and rethrows", async () => {
    const { offsets } = stubPages([
      { ids: ["c-0"], hasMore: true, contentLength: "100" },
      { ids: [], hasMore: false, status: 500 },
    ]);

    let thrown: unknown;
    const { events } = await diagnosticsDuring(() =>
      drainConversationList(ASSISTANT_ID).catch((error: unknown) => {
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
      bytes: null,
      listKind: "foreground",
      source: "drain",
    });
    expect(events[1]?.details).not.toHaveProperty("conversationType");
    expect(events[1]?.details).not.toHaveProperty("archiveStatus");

    expect(events[2]?.details).toMatchObject({
      outcome: "error",
      // Only the page that resolved counts toward the drain.
      pages: 1,
      rows: 1,
      totalBytes: 100,
    });
  });

  test("a failing page's error entry carries the response size", async () => {
    stubPages([{ ids: [], hasMore: false, status: 500, contentLength: "77" }]);

    const { events } = await diagnosticsDuring(() =>
      drainConversationList(ASSISTANT_ID).catch(() => undefined),
    );

    const errorEntry = events.find(
      (event) => event.kind === "conversation_list_page_fetch_error",
    );
    expect(errorEntry?.details).toMatchObject({ status: 500, bytes: 77 });
  });

  test("a failing page's error entry carries the list kind", async () => {
    stubPages([{ ids: [], hasMore: false, status: 500 }]);

    const { events } = await diagnosticsDuring(() =>
      drainConversationList(ASSISTANT_ID, BACKGROUND_FILTER).catch(
        () => undefined,
      ),
    );

    const errorEntry = events.find(
      (event) => event.kind === "conversation_list_page_fetch_error",
    );
    expect(errorEntry?.details).toMatchObject({
      listKind: "background",
      source: "drain",
    });
    expect(errorEntry?.details).not.toHaveProperty("archiveStatus");
  });

  test("a failing existence probe is labeled so it cannot pass as a drain failure", async () => {
    stubPages([{ ids: [], hasMore: false, status: 500 }]);

    const { events, result } = await diagnosticsDuring(() =>
      hasAnyActiveConversation(ASSISTANT_ID).catch(() => "threw"),
    );

    expect(result).toBe("threw");
    const errorEntry = events.find(
      (event) => event.kind === "conversation_list_page_fetch_error",
    );
    expect(errorEntry?.details).toMatchObject({
      listKind: "foreground",
      source: "existence_probe",
    });
    expect(
      events.filter((event) => event.kind === "conversation_list_page_fetch"),
    ).toHaveLength(0);
  });

  test("both archive-page drain summaries are labeled archived", async () => {
    // The archive view reads two lists (archived, archived background), so
    // it produces two summaries, and both are archive-page cost.
    stubPages([
      { ids: ["c-0"], hasMore: false, contentLength: "10" },
      { ids: ["c-1"], hasMore: false, contentLength: "20" },
    ]);

    const { events } = await diagnosticsDuring(() => drainArchived());
    const summaries = events.filter(
      (event) => event.kind === "conversation_list_drain",
    );

    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(summary.details).toMatchObject({ listKind: "archived" });
      expect(summary.details).not.toHaveProperty("conversationType");
    }
  });

  test("page-0 entries carry the drain's list kind and a drain source", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "10" }]);
    const background = await diagnosticsDuring(() =>
      drainConversationList(ASSISTANT_ID, BACKGROUND_FILTER),
    );

    expect(background.events[0]?.details).toMatchObject({
      offset: 0,
      listKind: "background",
      source: "drain",
    });

    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "10" }]);
    const channel = await diagnosticsDuring(() =>
      drainConversationList(ASSISTANT_ID, { originChannel: "slack" }),
    );

    expect(channel.events[0]?.details).toMatchObject({
      offset: 0,
      listKind: "origin_channel",
      source: "drain",
    });

    // The archive view reads two lists (archived, archived background), so
    // both of its page-0 entries are archive-page cost.
    stubPages([
      { ids: ["c-0"], hasMore: false, contentLength: "10" },
      { ids: ["c-1"], hasMore: false, contentLength: "20" },
    ]);
    const archived = await diagnosticsDuring(() => drainArchived());
    const pageEntries = archived.events.filter(
      (event) => event.kind === "conversation_list_page_fetch",
    );

    expect(pageEntries).toHaveLength(2);
    for (const entry of pageEntries) {
      expect(entry.details).toMatchObject({
        listKind: "archived",
        source: "drain",
      });
    }
  });

  test("bytes is null when content-length is absent and numeric when present", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false }]);
    const withoutHeader = await diagnosticsDuring(() =>
      drainConversationList(ASSISTANT_ID),
    );

    expect(withoutHeader.events[0]?.details.bytes).toBeNull();
    expect(withoutHeader.events[1]?.details.totalBytes).toBeNull();

    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "4096" }]);
    const withHeader = await diagnosticsDuring(() =>
      drainConversationList(ASSISTANT_ID),
    );

    expect(withHeader.events[0]?.details.bytes).toBe(4096);
    expect(withHeader.events[1]?.details.totalBytes).toBe(4096);
  });

  test("bytes is null for a malformed or blank content-length", async () => {
    stubPages([
      { ids: ["c-0"], hasMore: false, contentLength: "not-a-number" },
    ]);
    const malformed = await diagnosticsDuring(() =>
      drainConversationList(ASSISTANT_ID),
    );

    expect(malformed.events[0]?.details.bytes).toBeNull();
    expect(malformed.events[1]?.details.totalBytes).toBeNull();

    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "" }]);
    const blank = await diagnosticsDuring(() =>
      drainConversationList(ASSISTANT_ID),
    );

    expect(blank.events[0]?.details.bytes).toBeNull();
    expect(blank.events[1]?.details.totalBytes).toBeNull();
  });

  test("every recorded detail value is a scalar or null", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "10" }]);

    const { events } = await diagnosticsDuring(() =>
      drainConversationList(ASSISTANT_ID),
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

describe("first-page fetch diagnostics", () => {
  test("records a page entry with the response's real status and bytes", async () => {
    stubPages([
      { ids: ["c-0", "c-1"], hasMore: true, status: 206, contentLength: "128" },
    ]);

    const { events } = await diagnosticsDuring(() =>
      listConversationsFirstPage(ASSISTANT_ID),
    );

    expect(events.map((e) => e.kind)).toEqual(["conversation_list_page_fetch"]);
    expect(events[0]?.details).toMatchObject({
      assistantId: ASSISTANT_ID,
      offset: 0,
      status: 206,
      count: 2,
      hasMore: true,
      bytes: 128,
      listKind: "foreground",
      source: "first_page_refresh",
    });
    expect(typeof events[0]?.details.durationMs).toBe("number");
    // A single page is not a drain, so nothing reaches the telemetry rail.
    expect(emitClientPerfEventMock.mock.calls).toHaveLength(0);
  });

  test("labels the background bucket's entry with its list kind", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "12" }]);

    const { events } = await diagnosticsDuring(() =>
      listConversationsFirstPage(ASSISTANT_ID, BACKGROUND_FILTER),
    );

    expect(events[0]?.details).toMatchObject({
      offset: 0,
      status: 200,
      listKind: "background",
      source: "first_page_refresh",
      bytes: 12,
    });
  });

  test("labels the scheduled bucket's entry with its list kind", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "12" }]);

    const { events } = await diagnosticsDuring(() =>
      listConversationsFirstPage(ASSISTANT_ID, SCHEDULED_FILTER),
    );

    expect(events[0]?.details).toMatchObject({
      offset: 0,
      listKind: "scheduled",
      source: "first_page_refresh",
    });
  });

  test("bytes is null for a malformed content-length", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "abc" }]);

    const { events } = await diagnosticsDuring(() =>
      listConversationsFirstPage(ASSISTANT_ID),
    );

    expect(events[0]?.details.bytes).toBeNull();
  });

  test("returns only the public page shape, with no timing fields", async () => {
    stubPages([{ ids: ["c-0"], hasMore: true, contentLength: "128" }]);

    const page = await listConversationsFirstPage(ASSISTANT_ID);

    expect(Object.keys(page).sort()).toEqual(["conversations", "hasMore"]);
    expect(page.hasMore).toBe(true);
    expect(page.conversations).toHaveLength(1);
  });
});

describe("conversation list drain telemetry", () => {
  test("a 3-page drain emits one client_list.drain, not one per page", async () => {
    stubPages([
      { ids: ["c-0"], hasMore: true, contentLength: "100" },
      { ids: ["c-1"], hasMore: true, contentLength: "200" },
      { ids: ["c-2"], hasMore: false, contentLength: "50" },
    ]);

    await drainConversationList(ASSISTANT_ID);

    expect(emitClientPerfEventMock.mock.calls).toHaveLength(1);
    const emits = drainEmits();
    expect(emits).toHaveLength(1);
    expect(typeof emits[0]?.value).toBe("number");
    expect(emits[0]?.detail).toEqual({
      outcome: "ok",
      pages: 3,
      rows: 3,
      max_page_ms: expect.any(Number),
      total_bytes: 350,
      list_kind: "foreground",
    });
  });

  test("a background drain reports its own list_kind", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "10" }]);

    await drainConversationList(ASSISTANT_ID, BACKGROUND_FILTER);

    const emits = drainEmits();
    expect(emits).toHaveLength(1);
    expect(emits[0]?.detail).toMatchObject({
      outcome: "ok",
      pages: 1,
      list_kind: "background",
    });
  });

  test("a scheduled drain reports its own list_kind", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "10" }]);

    await drainConversationList(ASSISTANT_ID, SCHEDULED_FILTER);

    const emits = drainEmits();
    expect(emits).toHaveLength(1);
    expect(emits[0]?.detail).toMatchObject({ list_kind: "scheduled" });
  });

  test("an origin-channel drain is labeled origin_channel, not foreground", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "10" }]);

    await drainConversationList(ASSISTANT_ID, { originChannel: "slack" });

    const emits = drainEmits();
    expect(emits).toHaveLength(1);
    expect(emits[0]?.detail).toMatchObject({
      outcome: "ok",
      pages: 1,
      list_kind: "origin_channel",
    });
  });

  test("both archive-page drains are labeled archived, not foreground or background", async () => {
    // The archive view reads two lists (archived, archived background) in
    // parallel, so it produces two emits.
    stubPages([
      { ids: ["c-0"], hasMore: false, contentLength: "10" },
      { ids: ["c-1"], hasMore: false, contentLength: "20" },
    ]);

    await drainArchived();

    const emits = drainEmits();
    expect(emits).toHaveLength(2);
    expect(emits.map((emit) => emit.detail.list_kind)).toEqual([
      "archived",
      "archived",
    ]);
  });

  test("the detail bag carries no assistant id, and null bytes when content-length is absent", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false }]);

    await drainConversationList(ASSISTANT_ID);

    const emits = drainEmits();
    expect(emits).toHaveLength(1);
    const detail = emits[0]!.detail;
    for (const key of Object.keys(detail)) {
      expect(key.toLowerCase()).not.toContain("assistant");
    }
    expect(Object.values(detail)).not.toContain(ASSISTANT_ID);
    expect(detail.total_bytes).toBeNull();
  });

  test("the numeric detail fields ride as raw numbers, not strings", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "64" }]);

    await drainConversationList(ASSISTANT_ID);

    const detail = drainEmits()[0]!.detail;
    for (const key of ["pages", "rows", "max_page_ms", "total_bytes"]) {
      expect(typeof detail[key]).toBe("number");
    }
  });

  test("a failing drain emits outcome error and still rethrows", async () => {
    stubPages([
      { ids: ["c-0"], hasMore: true, contentLength: "100" },
      { ids: [], hasMore: false, status: 500 },
    ]);

    let thrown: unknown;
    await drainConversationList(ASSISTANT_ID).catch((error: unknown) => {
      thrown = error;
    });

    expect(thrown).toBeInstanceOf(ApiError);
    const emits = drainEmits();
    expect(emits).toHaveLength(1);
    expect(emits[0]?.detail).toMatchObject({
      outcome: "error",
      pages: 1,
      rows: 1,
      list_kind: "foreground",
    });
  });
});

/*
 * The section filter is what the whole per-section arrangement rests on: if a
 * filter is dropped on the way to the wire the request still succeeds, it just
 * answers with a superset, and the section renders rows that are not its own.
 * That failure is silent, so it gets assertions on the query itself rather than
 * on the returned rows.
 */
describe("section list filters", () => {
  test("forwards groupId to the daemon on every page of the drain", async () => {
    const { queries } = stubPages([
      { ids: ["c-0"], hasMore: true },
      { ids: ["c-1"], hasMore: false },
    ]);

    await drainConversationList(ASSISTANT_ID, {
      groupId: "system:pinned",
    });

    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.groupId).toBe("system:pinned");
    }
  });

  test("sends both filters for a channel inside the ungrouped remainder", async () => {
    // `origin_channel` is a separate column from `group_id`, so a channel card
    // constrains on both: without the group filter a conversation filed into a
    // custom group would render in that group AND in its channel.
    const { queries } = stubPages([{ ids: ["c-0"], hasMore: false }]);

    await drainConversationList(ASSISTANT_ID, {
      groupId: "system:all",
      originChannel: "slack",
    });

    expect(queries[0]).toMatchObject({
      groupId: "system:all",
      originChannel: "slack",
    });
  });

  test("omits the filters it was not given rather than sending empties", async () => {
    const { queries } = stubPages([{ ids: ["c-0"], hasMore: false }]);

    await drainConversationList(ASSISTANT_ID, { groupId: "grp-a" });

    expect(queries[0]).not.toHaveProperty("originChannel");
  });

  test("the first-page fetch carries the filter at offset 0", async () => {
    // One request, carrying the section's filter, or the section renders a
    // superset.
    const { queries } = stubPages([{ ids: ["c-0"], hasMore: true }]);

    const page = await listConversationsFirstPage(ASSISTANT_ID, {
      groupId: "system:all",
      originChannel: "slack",
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      offset: 0,
      groupId: "system:all",
      originChannel: "slack",
    });
    expect(page.hasMore).toBe(true);
  });

  test("a load-more page carries the filter and its offset", async () => {
    const { queries } = stubPages([{ ids: ["c-50"], hasMore: false }]);

    const page = await listConversationsPage(
      ASSISTANT_ID,
      { groupId: "grp-a" },
      50,
    );

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ offset: 50, groupId: "grp-a" });
    expect(page.hasMore).toBe(false);
  });

  test("labels a group-only drain 'section', keeping it distinct from a channel", async () => {
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "10" }]);
    const group = await diagnosticsDuring(() =>
      drainConversationList(ASSISTANT_ID, { groupId: "system:pinned" }),
    );

    expect(group.events[0]?.details).toMatchObject({
      listKind: "section",
      source: "drain",
    });

    // A channel section carries a groupId too, and still labels as the channel
    // so the bounded per-channel budget stays readable.
    stubPages([{ ids: ["c-0"], hasMore: false, contentLength: "10" }]);
    const channel = await diagnosticsDuring(() =>
      drainConversationList(ASSISTANT_ID, {
        groupId: "system:all",
        originChannel: "slack",
      }),
    );

    expect(channel.events[0]?.details).toMatchObject({
      listKind: "origin_channel",
    });
  });
});
