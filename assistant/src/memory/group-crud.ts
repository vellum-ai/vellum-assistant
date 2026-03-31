/**
 * CRUD operations for conversation groups.
 *
 * All functions call ensureGroupMigration() before any DB access
 * to guarantee the conversation_groups table exists.
 */

import { v4 as uuid } from "uuid";

import { ensureGroupMigration } from "./conversation-group-migration.js";
import { rawAll, rawExec, rawGet, rawRun } from "./db.js";

export interface ConversationGroupRow {
  id: string;
  name: string;
  sortPosition: number;
  isSystemGroup: boolean;
  createdAt?: number;
  updatedAt?: number;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function listGroups(): ConversationGroupRow[] {
  ensureGroupMigration();
  const rows = rawAll<{
    id: string;
    name: string;
    sort_position: number;
    is_system_group: number;
    created_at: number;
    updated_at: number;
  }>(
    "SELECT id, name, sort_position, is_system_group, created_at, updated_at FROM conversation_groups WHERE id != '_backfill_complete' ORDER BY sort_position ASC",
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sortPosition: r.sort_position,
    isSystemGroup: r.is_system_group === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

export function getGroup(groupId: string): ConversationGroupRow | null {
  ensureGroupMigration();
  const row = rawGet<{
    id: string;
    name: string;
    sort_position: number;
    is_system_group: number;
    created_at: number;
    updated_at: number;
  }>(
    "SELECT id, name, sort_position, is_system_group, created_at, updated_at FROM conversation_groups WHERE id = ?",
    groupId,
  );
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    sortPosition: row.sort_position,
    isSystemGroup: row.is_system_group === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a custom group. Server assigns sort_position as max(custom) + 1.
 * System groups occupy positions 0 (pinned), 1 (scheduled), 2 (background).
 * First custom group gets position 3. Fallback ?? 2 ensures 2 + 1 = 3 when
 * no custom groups exist.
 */
export function createGroup(name: string): ConversationGroupRow {
  ensureGroupMigration();
  const maxPos =
    rawGet<{ max: number | null }>(
      "SELECT MAX(sort_position) as max FROM conversation_groups WHERE is_system_group = 0",
    )?.max ?? 2;
  const sortPosition = maxPos + 1;
  const id = uuid();
  const now = Math.floor(Date.now() / 1000);
  rawRun(
    "INSERT INTO conversation_groups (id, name, sort_position, is_system_group, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
    id,
    name,
    sortPosition,
    now,
    now,
  );
  return {
    id,
    name,
    sortPosition,
    isSystemGroup: false,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export function updateGroup(
  groupId: string,
  updates: { name?: string; sortPosition?: number },
): ConversationGroupRow | null {
  ensureGroupMigration();
  const existing = getGroup(groupId);
  if (!existing) return null;

  const fields: string[] = [];
  const values: (string | number)[] = [];

  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.sortPosition !== undefined) {
    fields.push("sort_position = ?");
    values.push(updates.sortPosition);
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  const now = Math.floor(Date.now() / 1000);
  values.push(now);
  values.push(groupId);

  rawRun(
    `UPDATE conversation_groups SET ${fields.join(", ")} WHERE id = ?`,
    ...values,
  );

  return getGroup(groupId);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

// Relies on PRAGMA foreign_keys = ON (set at connection time) so that
// ON DELETE SET NULL fires and clears group_id on conversations when
// a group is deleted. If FK enforcement is ever disabled, orphaned
// group_id values would persist and conversations would appear in a
// non-existent group.
export function deleteGroup(groupId: string): boolean {
  ensureGroupMigration();
  rawRun("DELETE FROM conversation_groups WHERE id = ?", groupId);
  return true;
}

// ---------------------------------------------------------------------------
// Reorder
// ---------------------------------------------------------------------------

export function reorderGroups(
  updates: Array<{ groupId: string; sortPosition: number }>,
): void {
  ensureGroupMigration();
  const now = Math.floor(Date.now() / 1000);
  rawExec("BEGIN");
  try {
    for (const update of updates) {
      rawRun(
        "UPDATE conversation_groups SET sort_position = ?, updated_at = ? WHERE id = ?",
        update.sortPosition,
        now,
        update.groupId,
      );
    }
    rawExec("COMMIT");
  } catch (err) {
    rawExec("ROLLBACK");
    throw err;
  }
}
