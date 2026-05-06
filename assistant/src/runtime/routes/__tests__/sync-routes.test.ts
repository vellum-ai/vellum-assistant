import { beforeEach, describe, expect, test } from "bun:test";

import { SYNC_TAGS } from "../../../daemon/message-types/sync.js";
import { getSqlite } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import { recordSyncChanges } from "../../../memory/sync-change-store.js";
import { ROUTES } from "../sync-routes.js";

initializeDb();

function clearSyncChanges(): void {
  getSqlite().run("DELETE FROM sync_changes");
  getSqlite().run("DELETE FROM sqlite_sequence WHERE name = 'sync_changes'");
}

function routeHandler(endpoint: string) {
  const route = ROUTES.find((item) => item.endpoint === endpoint);
  if (!route) throw new Error(`Route not found: ${endpoint}`);
  return route.handler;
}

beforeEach(() => {
  clearSyncChanges();
});

describe("sync routes", () => {
  test("GET /sync/state returns latest cursor", () => {
    const handler = routeHandler("sync/state");
    expect(handler({})).toEqual({
      latestCursor: 0,
      retentionFloorCursor: 0,
    });

    recordSyncChanges([
      {
        resource: "assistant",
        resourceId: "self",
        op: "updated",
        invalidatedTags: [SYNC_TAGS.assistantAvatar],
      },
    ]);

    expect(handler({})).toEqual({
      latestCursor: 1,
      retentionFloorCursor: 0,
    });
  });

  test("GET /sync/changes returns paginated changes since cursor", () => {
    recordSyncChanges([
      {
        resource: "assistant",
        resourceId: "self",
        op: "updated",
        invalidatedTags: [SYNC_TAGS.assistantAvatar],
      },
      {
        resource: "assistant",
        resourceId: "self",
        op: "updated",
        invalidatedTags: [SYNC_TAGS.assistantIdentity],
      },
    ]);

    const handler = routeHandler("sync/changes");
    const body = handler({
      queryParams: { since: "0", limit: "1" },
    }) as {
      changes: Array<{ cursor: number }>;
      latestCursor: number;
      hasMore: boolean;
      snapshotRequired: boolean;
    };

    expect(body.changes.map((change) => change.cursor)).toEqual([1]);
    expect(body.latestCursor).toBe(2);
    expect(body.hasMore).toBe(true);
    expect(body.snapshotRequired).toBe(false);
  });

  test("GET /sync/changes marks malformed cursors as snapshot required", () => {
    const handler = routeHandler("sync/changes");
    const body = handler({
      queryParams: { since: "not-a-number" },
    }) as { changes: unknown[]; snapshotRequired: boolean };

    expect(body.changes).toEqual([]);
    expect(body.snapshotRequired).toBe(true);
  });

  test("GET /sync/changes marks cursors older than retention floor as snapshot required", () => {
    recordSyncChanges([
      {
        resource: "assistant",
        resourceId: "self",
        op: "updated",
        invalidatedTags: [SYNC_TAGS.assistantAvatar],
      },
      {
        resource: "assistant",
        resourceId: "self",
        op: "updated",
        invalidatedTags: [SYNC_TAGS.assistantIdentity],
      },
    ]);
    getSqlite().run("DELETE FROM sync_changes WHERE cursor = 1");

    const handler = routeHandler("sync/changes");
    const body = handler({
      queryParams: { since: "0" },
    }) as {
      changes: unknown[];
      latestCursor: number;
      snapshotRequired: boolean;
      retentionFloorCursor: number;
    };

    expect(body.changes).toEqual([]);
    expect(body.latestCursor).toBe(2);
    expect(body.retentionFloorCursor).toBe(1);
    expect(body.snapshotRequired).toBe(true);
  });
});
