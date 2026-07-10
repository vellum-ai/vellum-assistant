/**
 * Tests for the conversation surface API — the explicit opt-in that promotes
 * a background/scheduled conversation into the default ("standard")
 * conversation listing so clients show it in the Recents sidebar grouping.
 *
 * Exercises:
 *  - POST /v1/conversations/:id/surface (set + clear, validation, 404)
 *  - GET  /v1/conversations default listing inclusion of surfaced rows
 *  - GET  /v1/conversations?conversationType=background|scheduled unchanged
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the event hub to avoid spinning up real SSE infrastructure.
mock.module("../../assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => () => {},
  },
  broadcastMessage: () => {},
}));

// Spy on the sync publish so we can assert the invalidation fires after a
// successful write without standing up the real broadcast machinery.
const publishedListAndMetadata: Array<{
  reason: string;
  conversationIds: string | string[];
}> = [];
mock.module("../../sync/resource-sync-events.js", () => ({
  publishConversationListChanged: () => {},
  publishConversationTitleChanged: () => {},
  publishConversationListAndMetadataChanged: (
    reason: string,
    conversationIds: string | string[],
  ) => {
    publishedListAndMetadata.push({ reason, conversationIds });
  },
}));

import {
  createConversation,
  getConversation,
} from "../../../persistence/conversation-crud.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { conversations } from "../../../persistence/schema/index.js";
import { ROUTES as CONVERSATION_LIST_ROUTES } from "../conversation-list-routes.js";
import { ROUTES as CONVERSATION_MANAGEMENT_ROUTES } from "../conversation-management-routes.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { RouteDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

await initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findHandler(routes: RouteDefinition[], operationId: string) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

const surfaceHandler = findHandler(
  CONVERSATION_MANAGEMENT_ROUTES,
  "surfaceConversation",
);
const listHandler = findHandler(CONVERSATION_LIST_ROUTES, "listConversations");
const reorderHandler = findHandler(
  CONVERSATION_MANAGEMENT_ROUTES,
  "reorderConversations",
);

interface SurfaceResponse {
  ok: boolean;
  conversationId: string;
  surfacedAt: number | null;
}

interface ConversationSummary {
  id: string;
  title: string;
  conversationType: string;
  surfacedAt?: number;
}

interface ListResponse {
  conversations: ConversationSummary[];
  nextOffset: number;
  hasMore: boolean;
}

function clearConversations(): void {
  getDb().delete(conversations).run();
}

function seed(
  title: string,
  conversationType: "standard" | "background" | "scheduled",
): string {
  return createConversation({ title, conversationType, source: "test" }).id;
}

function listIds(queryParams: Record<string, string> = {}): string[] {
  const response = listHandler({ queryParams }) as ListResponse;
  return response.conversations.map((c) => c.id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/conversations/:id/surface", () => {
  beforeEach(() => {
    clearConversations();
    publishedListAndMetadata.length = 0;
  });

  test("surfaces a background conversation and returns the timestamp", () => {
    const id = seed("Background run", "background");
    const before = Date.now();
    const response = surfaceHandler({
      pathParams: { id },
      body: { surfaced: true },
    }) as SurfaceResponse;
    expect(response.ok).toBe(true);
    expect(response.conversationId).toBe(id);
    expect(response.surfacedAt).toBeGreaterThanOrEqual(before);
  });

  test("publishes a shape-changing list invalidation after the write", () => {
    const id = seed("Background run", "background");
    surfaceHandler({ pathParams: { id }, body: { surfaced: true } });
    expect(publishedListAndMetadata).toEqual([
      { reason: "reordered", conversationIds: id },
    ]);
  });

  test("clearing returns surfacedAt null", () => {
    const id = seed("Background run", "background");
    surfaceHandler({ pathParams: { id }, body: { surfaced: true } });
    const response = surfaceHandler({
      pathParams: { id },
      body: { surfaced: false },
    }) as SurfaceResponse;
    expect(response.surfacedAt).toBeNull();
  });

  test("404s for an unknown conversation id", () => {
    expect(() =>
      surfaceHandler({
        pathParams: { id: crypto.randomUUID() },
        body: { surfaced: true },
      }),
    ).toThrow(NotFoundError);
  });

  test("400s when surfaced is missing or not a boolean", () => {
    const id = seed("Background run", "background");
    expect(() => surfaceHandler({ pathParams: { id }, body: {} })).toThrow(
      BadRequestError,
    );
    expect(() =>
      surfaceHandler({ pathParams: { id }, body: { surfaced: "yes" } }),
    ).toThrow(BadRequestError);
  });
});

describe("GET /v1/conversations — surfaced rows in the default listing", () => {
  beforeEach(() => {
    clearConversations();
    publishedListAndMetadata.length = 0;
  });

  test("background/scheduled rows stay out of the default listing until surfaced", () => {
    const standardId = seed("Standard chat", "standard");
    seed("Background run", "background");
    seed("Scheduled run", "scheduled");
    expect(listIds()).toEqual([standardId]);
  });

  test("surfacing promotes a background conversation into the default listing", () => {
    const standardId = seed("Standard chat", "standard");
    const backgroundId = seed("Background run", "background");
    surfaceHandler({
      pathParams: { id: backgroundId },
      body: { surfaced: true },
    });

    const response = listHandler({ queryParams: {} }) as ListResponse;
    expect(response.conversations.map((c) => c.id).sort()).toEqual(
      [standardId, backgroundId].sort(),
    );
    const surfaced = response.conversations.find((c) => c.id === backgroundId)!;
    expect(surfaced.conversationType).toBe("background");
    expect(surfaced.surfacedAt).toBeGreaterThan(0);
    const standard = response.conversations.find((c) => c.id === standardId)!;
    expect(standard.surfacedAt).toBeUndefined();
  });

  test("surfacing promotes a scheduled conversation into the default listing", () => {
    const scheduledId = seed("Scheduled run", "scheduled");
    surfaceHandler({
      pathParams: { id: scheduledId },
      body: { surfaced: true },
    });
    expect(listIds()).toEqual([scheduledId]);
  });

  test("clearing the promotion removes the row from the default listing again", () => {
    const backgroundId = seed("Background run", "background");
    surfaceHandler({
      pathParams: { id: backgroundId },
      body: { surfaced: true },
    });
    expect(listIds()).toEqual([backgroundId]);

    surfaceHandler({
      pathParams: { id: backgroundId },
      body: { surfaced: false },
    });
    expect(listIds()).toEqual([]);
  });

  test("filtered background/scheduled listings keep returning surfaced rows", () => {
    const backgroundId = seed("Background run", "background");
    const scheduledId = seed("Scheduled run", "scheduled");
    surfaceHandler({
      pathParams: { id: backgroundId },
      body: { surfaced: true },
    });
    surfaceHandler({
      pathParams: { id: scheduledId },
      body: { surfaced: true },
    });

    // "background" is the back-compat umbrella (background + scheduled).
    expect(listIds({ conversationType: "background" }).sort()).toEqual(
      [backgroundId, scheduledId].sort(),
    );
    expect(listIds({ conversationType: "scheduled" })).toEqual([scheduledId]);
  });

  test("moving a surfaced conversation to system:background clears the promotion", () => {
    const backgroundId = seed("Background run", "background");
    surfaceHandler({
      pathParams: { id: backgroundId },
      body: { surfaced: true },
    });
    expect(listIds()).toEqual([backgroundId]);

    // Move-to-Group sends only groupId/isPinned through the reorder
    // endpoint — the demotion out of Recents must happen in the same
    // server-side write, with no second API call from the client.
    reorderHandler({
      body: {
        updates: [
          { conversationId: backgroundId, groupId: "system:background" },
        ],
      },
    });

    expect(getConversation(backgroundId)?.surfacedAt).toBeNull();
    expect(listIds()).toEqual([]);
    expect(listIds({ conversationType: "background" })).toEqual([backgroundId]);
  });

  test("moving a surfaced conversation to system:scheduled clears the promotion", () => {
    const scheduledId = seed("Scheduled run", "scheduled");
    surfaceHandler({
      pathParams: { id: scheduledId },
      body: { surfaced: true },
    });
    expect(listIds()).toEqual([scheduledId]);

    reorderHandler({
      body: {
        updates: [{ conversationId: scheduledId, groupId: "system:scheduled" }],
      },
    });

    expect(getConversation(scheduledId)?.surfacedAt).toBeNull();
    expect(listIds()).toEqual([]);
  });

  test("moving a surfaced conversation to a non-demoting group keeps the promotion", () => {
    const backgroundId = seed("Background run", "background");
    surfaceHandler({
      pathParams: { id: backgroundId },
      body: { surfaced: true },
    });

    reorderHandler({
      body: {
        updates: [{ conversationId: backgroundId, groupId: "system:all" }],
      },
    });

    expect(getConversation(backgroundId)?.surfacedAt).toBeGreaterThan(0);
  });

  test("archived surfaced rows stay out of the default (active) listing", () => {
    const backgroundId = seed("Background run", "background");
    surfaceHandler({
      pathParams: { id: backgroundId },
      body: { surfaced: true },
    });
    getDb().update(conversations).set({ archivedAt: Date.now() }).run();
    expect(listIds()).toEqual([]);
  });
});
