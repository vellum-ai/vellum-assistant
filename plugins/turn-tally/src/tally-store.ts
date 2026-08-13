/**
 * Plugin-owned SQLite store for per-conversation activity tallies
 * (`tally.sqlite` in the plugin's storage dir).
 *
 * The store follows the plugin state-ownership contract: the `init` hook
 * opens it and applies the schema idempotently, `shutdown` closes it,
 * `conversation-deleted` purges the deleted conversation's rows, and
 * `conversations-cleared` wipes it wholesale. Nothing is persisted outside
 * the plugin's own `data/` directory.
 *
 * Every operation fails open: when the database cannot be opened or a
 * statement errors, reads return empty results and writes are dropped, so
 * a broken store never surfaces an error into the turn.
 *
 * Surfaces that the host imports outside the plugin's module graph (HTTP
 * routes are re-imported with a cache-busting URL, so they get a fresh
 * module instance whose handle starts unset) reach the same file through
 * {@link ensureOpen}, which lazily opens the database at the installed
 * plugin's storage path derived from the workspace dir.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { getWorkspaceDir } from "@vellumai/plugin-api";

/** Install-directory name; keep in sync with the plugin directory. */
export const PLUGIN_NAME = "turn-tally";

/** One conversation's recorded activity. */
export interface ConversationTally {
  conversationId: string;
  prompts: number;
  toolUses: number;
  lastExitReason: string | null;
  updatedAt: number;
  /** Per-tool counts, present only when tool-name tracking is enabled. */
  toolBreakdown: Array<{ toolName: string; uses: number }>;
}

let db: Database | null = null;

/** Storage path for an installed copy: `<workspaceDir>/plugins/<name>/data/`. */
function defaultDbPath(): string {
  const dir = join(getWorkspaceDir(), "plugins", PLUGIN_NAME, "data");
  mkdirSync(dir, { recursive: true });
  return join(dir, "tally.sqlite");
}

/**
 * Open (or create) the tally database at `dbPath` and ensure its schema.
 * Called by the `init` hook with a path inside `ctx.pluginStorageDir`.
 * Idempotent and fail-open: on error the handle stays unset and every
 * operation degrades to a no-op.
 */
export function openTallyStore(dbPath: string): void {
  try {
    closeTallyStore();
    const handle = new Database(dbPath);
    handle.exec("PRAGMA journal_mode=WAL");
    handle.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS conversation_tallies (
        conversation_id  TEXT PRIMARY KEY,
        prompts          INTEGER NOT NULL DEFAULT 0,
        tool_uses        INTEGER NOT NULL DEFAULT 0,
        last_exit_reason TEXT,
        updated_at       INTEGER NOT NULL
      )
    `);
    handle.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS tool_use_tallies (
        conversation_id TEXT NOT NULL,
        tool_name       TEXT NOT NULL,
        uses            INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (conversation_id, tool_name)
      )
    `);
    db = handle;
  } catch {
    db = null;
  }
}

/** Close the tally database. Called by the `shutdown` hook. */
export function closeTallyStore(): void {
  try {
    db?.close();
  } catch {
    // Already closed or unusable; either way the handle is discarded.
  }
  db = null;
}

/** Return the open handle, lazily opening at the default path when unset. */
function ensureOpen(): Database | null {
  if (db === null) {
    openTallyStore(defaultDbPath());
  }
  return db;
}

/** Upsert the conversation row, adding the given deltas. Returns the new prompt total. */
function bumpConversation(
  handle: Database,
  conversationId: string,
  promptDelta: number,
  toolUseDelta: number,
): number {
  const row = handle
    .query(
      /*sql*/ `
      INSERT INTO conversation_tallies (conversation_id, prompts, tool_uses, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        prompts = prompts + excluded.prompts,
        tool_uses = tool_uses + excluded.tool_uses,
        updated_at = excluded.updated_at
      RETURNING prompts
    `,
    )
    .get(conversationId, promptDelta, toolUseDelta, Date.now()) as {
    prompts: number;
  };
  return row.prompts;
}

/**
 * Count one submitted user prompt. Returns the conversation's updated
 * prompt total, or `null` when the store is unavailable.
 */
export function recordPrompt(conversationId: string): number | null {
  const handle = ensureOpen();
  if (handle === null) {
    return null;
  }
  try {
    return bumpConversation(handle, conversationId, 1, 0);
  } catch {
    return null;
  }
}

/**
 * Count one tool result. `toolName` is `null` when the caller could not
 * resolve it (or tool-name tracking is disabled); the total still counts.
 */
export function recordToolUse(
  conversationId: string,
  toolName: string | null,
): void {
  const handle = ensureOpen();
  if (handle === null) {
    return;
  }
  try {
    bumpConversation(handle, conversationId, 0, 1);
    if (toolName !== null) {
      handle
        .query(
          /*sql*/ `
          INSERT INTO tool_use_tallies (conversation_id, tool_name, uses)
          VALUES (?, ?, 1)
          ON CONFLICT(conversation_id, tool_name) DO UPDATE SET
            uses = uses + 1
        `,
        )
        .run(conversationId, toolName);
    }
  } catch {
    // Fail open: the tally is best-effort.
  }
}

/** Record how the conversation's most recent turn ended. */
export function recordExit(conversationId: string, exitReason: string): void {
  const handle = ensureOpen();
  if (handle === null) {
    return;
  }
  try {
    handle
      .query(
        /*sql*/ `
        INSERT INTO conversation_tallies (conversation_id, last_exit_reason, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          last_exit_reason = excluded.last_exit_reason,
          updated_at = excluded.updated_at
      `,
      )
      .run(conversationId, exitReason, Date.now());
  } catch {
    // Fail open: the tally is best-effort.
  }
}

function readBreakdown(
  handle: Database,
  conversationId: string,
): Array<{ toolName: string; uses: number }> {
  const rows = handle
    .query(
      /*sql*/ `SELECT tool_name, uses FROM tool_use_tallies WHERE conversation_id = ? ORDER BY uses DESC, tool_name ASC`,
    )
    .all(conversationId) as Array<{ tool_name: string; uses: number }>;
  return rows.map((row) => ({ toolName: row.tool_name, uses: row.uses }));
}

interface TallyRow {
  conversation_id: string;
  prompts: number;
  tool_uses: number;
  last_exit_reason: string | null;
  updated_at: number;
}

function rowToTally(handle: Database, row: TallyRow): ConversationTally {
  return {
    conversationId: row.conversation_id,
    prompts: row.prompts,
    toolUses: row.tool_uses,
    lastExitReason: row.last_exit_reason,
    updatedAt: row.updated_at,
    toolBreakdown: readBreakdown(handle, row.conversation_id),
  };
}

/** Read one conversation's tally, or `null` when none is recorded. */
export function getTally(conversationId: string): ConversationTally | null {
  const handle = ensureOpen();
  if (handle === null) {
    return null;
  }
  try {
    const row = handle
      .query(
        /*sql*/ `SELECT * FROM conversation_tallies WHERE conversation_id = ?`,
      )
      .get(conversationId) as TallyRow | null;
    return row === null ? null : rowToTally(handle, row);
  } catch {
    return null;
  }
}

/** Read every recorded tally, most recently active first. */
export function listTallies(): ConversationTally[] {
  const handle = ensureOpen();
  if (handle === null) {
    return [];
  }
  try {
    const rows = handle
      .query(
        /*sql*/ `SELECT * FROM conversation_tallies ORDER BY updated_at DESC`,
      )
      .all() as TallyRow[];
    return rows.map((row) => rowToTally(handle, row));
  } catch {
    return [];
  }
}

/**
 * Remove a deleted conversation's rows. Returns how many rows were
 * removed across both tables (0 when the store is unavailable).
 */
export function purgeConversation(conversationId: string): number {
  const handle = ensureOpen();
  if (handle === null) {
    return 0;
  }
  try {
    let removed = handle
      .query(/*sql*/ `DELETE FROM conversation_tallies WHERE conversation_id = ?`)
      .run(conversationId).changes;
    removed += handle
      .query(/*sql*/ `DELETE FROM tool_use_tallies WHERE conversation_id = ?`)
      .run(conversationId).changes;
    return removed;
  } catch {
    return 0;
  }
}

/** Wipe every tally. Called when all conversations are cleared at once. */
export function purgeAll(): void {
  const handle = ensureOpen();
  if (handle === null) {
    return;
  }
  try {
    handle.exec(/*sql*/ `DELETE FROM conversation_tallies`);
    handle.exec(/*sql*/ `DELETE FROM tool_use_tallies`);
  } catch {
    // Fail open: uninstall removes the data directory outright.
  }
}
