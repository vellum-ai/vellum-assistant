import type {
  SyncChange,
  SyncInvalidationTag,
  SyncOperation,
  SyncResource,
} from "../daemon/message-types/sync.js";
import { getSqlite } from "./db-connection.js";

export const DEFAULT_SYNC_CHANGE_RETENTION_ROWS = 10_000;

export interface SyncChangeInput {
  resource: SyncResource;
  resourceId: string;
  op: SyncOperation;
  invalidatedTags: SyncInvalidationTag[];
  version?: number;
  metadata?: Record<string, unknown>;
}

export interface RecordSyncChangesOptions {
  originClientId?: string;
  createdAt?: number;
  retentionRows?: number;
}

interface SyncChangeRow {
  cursor: number;
  created_at: number;
  resource: string;
  resource_id: string;
  op: string;
  version: number | null;
  invalidated_tags_json: string;
  origin_client_id: string | null;
  metadata_json: string | null;
}

export interface SyncCursorState {
  latestCursor: number;
  oldestCursor: number | null;
  retentionFloorCursor: number;
}

function parseJsonArray(value: string): SyncInvalidationTag[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === "string");
}

function parseMetadata(
  value: string | null,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function rowToSyncChange(row: SyncChangeRow): SyncChange {
  return {
    cursor: row.cursor,
    createdAt: row.created_at,
    resource: row.resource as SyncResource,
    resourceId: row.resource_id,
    op: row.op as SyncOperation,
    ...(row.version == null ? {} : { version: row.version }),
    invalidatedTags: parseJsonArray(row.invalidated_tags_json),
    ...(row.origin_client_id ? { originClientId: row.origin_client_id } : {}),
    ...(row.metadata_json
      ? { metadata: parseMetadata(row.metadata_json) }
      : {}),
  };
}

function assertValidChange(change: SyncChangeInput): void {
  if (change.resourceId.trim() === "") {
    throw new Error("Sync change resourceId must be non-empty");
  }
  if (change.invalidatedTags.length === 0) {
    throw new Error("Sync change must include at least one invalidated tag");
  }
  for (const tag of change.invalidatedTags) {
    if (tag.trim() === "") {
      throw new Error("Sync invalidation tags must be non-empty");
    }
  }
}

export function recordSyncChanges(
  changes: SyncChangeInput[],
  options: RecordSyncChangesOptions = {},
): SyncChange[] {
  if (changes.length === 0) return [];
  for (const change of changes) {
    assertValidChange(change);
  }

  const sqlite = getSqlite();
  const createdAt = options.createdAt ?? Date.now();
  const inserted: SyncChange[] = [];
  const insert = sqlite.prepare(/*sql*/ `
    INSERT INTO sync_changes (
      created_at,
      resource,
      resource_id,
      op,
      version,
      invalidated_tags_json,
      origin_client_id,
      metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectInserted = sqlite.prepare(
    /*sql*/ `SELECT * FROM sync_changes WHERE cursor = ?`,
  );

  sqlite.exec("BEGIN IMMEDIATE");
  try {
    for (const change of changes) {
      insert.run(
        createdAt,
        change.resource,
        change.resourceId,
        change.op,
        change.version ?? null,
        JSON.stringify(change.invalidatedTags),
        options.originClientId ?? null,
        change.metadata ? JSON.stringify(change.metadata) : null,
      );
      const cursor = (
        sqlite.query("SELECT last_insert_rowid() AS cursor").get() as {
          cursor: number;
        }
      ).cursor;
      const row = selectInserted.get(cursor) as SyncChangeRow | null;
      if (!row) {
        throw new Error(`Failed to load inserted sync change ${cursor}`);
      }
      inserted.push(rowToSyncChange(row));
    }
    pruneSyncChangesToRetention(
      options.retentionRows ?? DEFAULT_SYNC_CHANGE_RETENTION_ROWS,
    );
    sqlite.exec("COMMIT");
  } catch (err) {
    sqlite.exec("ROLLBACK");
    throw err;
  }

  return inserted;
}

export function listSyncChangesSince(
  cursor: number,
  limit = 100,
): SyncChange[] {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const rows = getSqlite()
    .query(
      /*sql*/ `
        SELECT * FROM sync_changes
        WHERE cursor > ?
        ORDER BY cursor ASC
        LIMIT ?
      `,
    )
    .all(Math.max(0, Math.floor(cursor)), boundedLimit) as SyncChangeRow[];
  return rows.map(rowToSyncChange);
}

export function getSyncCursorState(): SyncCursorState {
  const row = getSqlite()
    .query(
      /*sql*/ `
        SELECT
          MAX(cursor) AS latest_cursor,
          MIN(cursor) AS oldest_cursor
        FROM sync_changes
      `,
    )
    .get() as { latest_cursor: number | null; oldest_cursor: number | null };
  const latestCursor = row.latest_cursor ?? 0;
  const oldestCursor = row.oldest_cursor;
  return {
    latestCursor,
    oldestCursor,
    retentionFloorCursor:
      oldestCursor == null ? 0 : Math.max(0, oldestCursor - 1),
  };
}

export function pruneSyncChangesToRetention(
  retentionRows = DEFAULT_SYNC_CHANGE_RETENTION_ROWS,
): number {
  if (retentionRows <= 0) {
    return 0;
  }
  const sqlite = getSqlite();
  sqlite
    .query(
      /*sql*/ `
        DELETE FROM sync_changes
        WHERE cursor NOT IN (
          SELECT cursor FROM sync_changes
          ORDER BY cursor DESC
          LIMIT ?
        )
      `,
    )
    .run(Math.floor(retentionRows));
  return (sqlite.query("SELECT changes() AS c").get() as { c: number }).c;
}
