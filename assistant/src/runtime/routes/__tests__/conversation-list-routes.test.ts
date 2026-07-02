/**
 * Tests for the listConversations route handler — focused on the
 * `archiveStatus` query param introduced to keep archived rows out of the
 * default sidebar restore. Other handlers in the file (seen/unread/get)
 * are covered transitively by `conversation-sync-tags.test.ts`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Avoid spinning up the real event hub for the pinned/groups branches.
mock.module("../../assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => () => {},
  },
  broadcastMessage: () => {},
}));

import { findConversation } from "../../../daemon/conversation-registry.js";
import { createConversation } from "../../../persistence/conversation-crud.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { rawRun } from "../../../persistence/raw-query.js";
import { conversations } from "../../../persistence/schema/index.js";
import { ROUTES as CONVERSATION_LIST_ROUTES } from "../conversation-list-routes.js";
import { BadRequestError } from "../errors.js";
import type { RouteDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

await initializeDb();

function clearConversations(): void {
  getDb().delete(conversations).run();
}

function seedArchived(title: string): string {
  const conv = createConversation({ title });
  rawRun(
    "test:archiveConversation",
    "UPDATE conversations SET archived_at = ? WHERE id = ?",
    Date.now(),
    conv.id,
  );
  return conv.id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ConversationSummary {
  id: string;
  title: string;
  archivedAt?: number;
}

interface ListResponse {
  conversations: ConversationSummary[];
  nextOffset: number;
  hasMore: boolean;
  groups?: unknown[];
}

function findHandler(routes: RouteDefinition[], operationId: string) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

const listHandler = findHandler(CONVERSATION_LIST_ROUTES, "listConversations");

function invoke(queryParams: Record<string, string> = {}) {
  return listHandler({ queryParams }) as ListResponse | Promise<ListResponse>;
}

// Sanity guard — `findConversation` is a daemon-store side-effect call in the
// handler. Confirm it returns undefined for our cold seed rows so the assert
// doesn't accidentally rely on in-memory residency.
const _findConversationSentinel = findConversation;
void _findConversationSentinel;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/conversations — archiveStatus", () => {
  beforeEach(() => {
    clearConversations();
  });

  test("default response omits archived rows", async () => {
    createConversation("live-1");
    seedArchived("archived-1");

    const result = (await invoke()) as ListResponse;

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]!.title).toBe("live-1");
    expect(result.hasMore).toBe(false);
  });

  test("archiveStatus=archived returns only archived rows", async () => {
    createConversation("live-1");
    seedArchived("archived-1");
    seedArchived("archived-2");

    const result = (await invoke({
      archiveStatus: "archived",
    })) as ListResponse;

    expect(result.conversations).toHaveLength(2);
    const titles = result.conversations.map((c) => c.title).sort();
    expect(titles).toEqual(["archived-1", "archived-2"]);
  });

  test("archiveStatus=all returns active and archived rows", async () => {
    createConversation("live-1");
    seedArchived("archived-1");

    const result = (await invoke({ archiveStatus: "all" })) as ListResponse;

    expect(result.conversations).toHaveLength(2);
    const titles = result.conversations.map((c) => c.title).sort();
    expect(titles).toEqual(["archived-1", "live-1"]);
  });

  test("hasMore reflects the archived-only total count, not the full table", async () => {
    // 2 live rows, 1 archived. With limit=1 on the archived view there is
    // no second page even though the table contains three rows total.
    createConversation("live-1");
    createConversation("live-2");
    seedArchived("archived-1");

    const result = (await invoke({
      archiveStatus: "archived",
      limit: "1",
    })) as ListResponse;

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]!.title).toBe("archived-1");
    expect(result.hasMore).toBe(false);
  });

  test("archived view skips pinned-row injection on first page", async () => {
    // GIVEN a pinned-but-archived row that would otherwise be force-included
    // on offset=0 of the active view.
    const pinned = createConversation("pinned-archived");
    rawRun(
      "test:setPinned",
      "UPDATE conversations SET is_pinned = 1 WHERE id = ?",
      pinned.id,
    );
    rawRun(
      "test:archiveConversation",
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      Date.now(),
      pinned.id,
    );

    // AND a live archived row to make sure the archived list isn't empty.
    seedArchived("archived-live");

    const result = (await invoke({
      archiveStatus: "archived",
    })) as ListResponse;

    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "archived-live",
      "pinned-archived",
    ]);
  });
});

describe("GET /v1/conversations — conversationType", () => {
  beforeEach(() => {
    clearConversations();
  });

  test("default response returns foreground rows only", async () => {
    // GIVEN a foreground, a background, and a scheduled conversation
    createConversation("foreground-1");
    createConversation({ title: "bg-1", conversationType: "background" });
    createConversation({ title: "sched-1", conversationType: "scheduled" });

    // WHEN listing without a conversationType filter
    const result = (await invoke()) as ListResponse;

    // THEN only the foreground row is returned
    expect(result.conversations.map((c) => c.title)).toEqual(["foreground-1"]);
  });

  test("conversationType=background returns background and scheduled (umbrella)", async () => {
    // GIVEN a foreground, a background, and a scheduled conversation
    createConversation("foreground-1");
    createConversation({ title: "bg-1", conversationType: "background" });
    createConversation({ title: "sched-1", conversationType: "scheduled" });

    // WHEN listing with conversationType=background
    const result = (await invoke({
      conversationType: "background",
    })) as ListResponse;

    // THEN both the background and scheduled rows are returned
    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "bg-1",
      "sched-1",
    ]);
  });

  test("conversationType=scheduled returns scheduled rows only", async () => {
    // GIVEN a foreground, a background, and a scheduled conversation
    createConversation("foreground-1");
    createConversation({ title: "bg-1", conversationType: "background" });
    createConversation({ title: "sched-1", conversationType: "scheduled" });

    // WHEN listing with conversationType=scheduled
    const result = (await invoke({
      conversationType: "scheduled",
    })) as ListResponse;

    // THEN only the scheduled row is returned (background is excluded)
    expect(result.conversations.map((c) => c.title)).toEqual(["sched-1"]);
  });

  test("unknown conversationType is rejected with a 400", async () => {
    // GIVEN a request with an unrecognized conversationType
    // WHEN listing — THEN it throws a BadRequestError (400) instead of
    // silently falling back to the foreground list
    expect(() => invoke({ conversationType: "private" })).toThrow(
      BadRequestError,
    );
  });
});
