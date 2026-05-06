import { z } from "zod";

import {
  getSyncCursorState,
  listSyncChangesSince,
} from "../../memory/sync-change-store.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const DEFAULT_SYNC_CHANGES_LIMIT = 100;
const MAX_SYNC_CHANGES_LIMIT = 500;

const SyncChangeResponseSchema = z.object({
  cursor: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  resource: z.string(),
  resourceId: z.string(),
  op: z.string(),
  version: z.number().int().nonnegative().optional(),
  invalidatedTags: z.array(z.string()),
  originClientId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function parseCursor(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const cursor = Number(raw);
  if (!Number.isSafeInteger(cursor) || cursor < 0) return null;
  return cursor;
}

function parseLimit(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_SYNC_CHANGES_LIMIT;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return DEFAULT_SYNC_CHANGES_LIMIT;
  }
  return Math.min(limit, MAX_SYNC_CHANGES_LIMIT);
}

function handleGetSyncState() {
  const state = getSyncCursorState();
  return {
    latestCursor: state.latestCursor,
    retentionFloorCursor: state.retentionFloorCursor,
  };
}

function handleListSyncChanges({ queryParams = {} }: RouteHandlerArgs) {
  const state = getSyncCursorState();
  const since = parseCursor(queryParams.since);
  const limit = parseLimit(queryParams.limit);

  if (since == null || since < state.retentionFloorCursor) {
    return {
      changes: [],
      latestCursor: state.latestCursor,
      hasMore: false,
      snapshotRequired: true,
      retentionFloorCursor: state.retentionFloorCursor,
    };
  }

  const changes = listSyncChangesSince(since, limit + 1);
  const page = changes.slice(0, limit);
  return {
    changes: page,
    latestCursor: state.latestCursor,
    hasMore: changes.length > limit,
    snapshotRequired: false,
    retentionFloorCursor: state.retentionFloorCursor,
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getSyncState",
    endpoint: "sync/state",
    method: "GET",
    policyKey: "sync/state",
    summary: "Get sync cursor state",
    description:
      "Return the latest durable sync cursor so clients can initialize catch-up state.",
    tags: ["sync"],
    handler: handleGetSyncState,
    responseBody: z.object({
      latestCursor: z.number().int().nonnegative(),
      retentionFloorCursor: z.number().int().nonnegative(),
    }),
  },
  {
    operationId: "listSyncChanges",
    endpoint: "sync/changes",
    method: "GET",
    policyKey: "sync/changes",
    summary: "List sync changes since cursor",
    description:
      "Return durable sync invalidations newer than the provided cursor.",
    tags: ["sync"],
    queryParams: [
      {
        name: "since",
        type: "integer",
        required: true,
        description: "Last sync cursor observed by the client.",
      },
      {
        name: "limit",
        type: "integer",
        description: "Maximum number of changes to return.",
      },
    ],
    handler: handleListSyncChanges,
    responseBody: z.object({
      changes: z.array(SyncChangeResponseSchema),
      latestCursor: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      snapshotRequired: z.boolean(),
      retentionFloorCursor: z.number().int().nonnegative(),
    }),
  },
];
