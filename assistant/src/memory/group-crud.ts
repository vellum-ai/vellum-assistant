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
    "SELECT id, name, sort_position, is_system_group, created_at, updated_at FROM conversation_groups WHERE id NOT IN ('_backfill_complete', '_backfill_all_complete', '_sort_shift_complete') ORDER BY sort_position ASC",
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
 * System groups occupy positions 0–3 (pinned, scheduled, background, all).
 * First custom group gets position 4. Fallback ?? 3 ensures 3 + 1 = 4 when
 * no custom groups exist.
 */
export function createGroup(name: string): ConversationGroupRow {
  ensureGroupMigration();
  const maxPos =
    rawGet<{ max: number | null }>(
      "SELECT MAX(sort_position) as max FROM conversation_groups WHERE is_system_group = 0",
    )?.max ?? 3;
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

// Reassign conversations to system:all before deleting the group so they
// don't end up with NULL group_id (which would violate the system:all
// invariant). The FK ON DELETE SET NULL would otherwise leave NULLs that
// the one-time backfill won't re-fix.
export function deleteGroup(groupId: string): boolean {
  ensureGroupMigration();
  rawRun(
    "UPDATE conversations SET group_id = 'system:all' WHERE group_id = ?",
    groupId,
  );
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
      // Look up the group first — skip unknown/stale IDs and system groups
      const group = rawGet<{ id: string; is_system_group: number }>(
        "SELECT id, is_system_group FROM conversation_groups WHERE id = ?",
        update.groupId,
      );
      if (!group) continue;
      if (group.is_system_group === 1) continue;

      if (update.sortPosition < 4) {
        throw new Error(
          `Custom group sort_position must be >= 4 (got ${update.sortPosition} for ${update.groupId})`,
        );
      }
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
