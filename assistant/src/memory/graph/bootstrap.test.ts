import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { setMemoryCheckpoint } from "../checkpoints.js";
import {
  initializeDb,
  rawAll,
  rawGet,
  rawRun,
  resetTestTables,
} from "../db.js";
import { migrateToolCreatedItems } from "./bootstrap.js";

// ---------------------------------------------------------------------------
// The checkpoint key used by migrateToolCreatedItems (not exported, so we
// inline the literal value).
// ---------------------------------------------------------------------------
const MIGRATE_ITEMS_CHECKPOINT = "graph_bootstrap:migrated_tool_items";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  initializeDb();
});

beforeEach(() => {
  // Clear graph nodes and checkpoints between tests so each test starts clean.
  resetTestTables("memory_graph_nodes", "memory_checkpoints", "memory_jobs");
});

// ---------------------------------------------------------------------------
// migrateToolCreatedItems
// ---------------------------------------------------------------------------

describe("migrateToolCreatedItems", () => {
  test("migrates legacy memory_items to graph nodes", () => {
    // The memory_items table has been dropped by migration 203, so we need to
    // recreate it for this test. We create a minimal version with just the
    // columns the migration reads.
    rawRun(
      `CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        statement TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL,
        scope_id TEXT NOT NULL DEFAULT 'default',
        first_seen_at INTEGER NOT NULL,
        fingerprint TEXT NOT NULL DEFAULT ''
      )`,
    );

    try {
      // Insert a legacy playbook item
      rawRun(
        `INSERT INTO memory_items (id, kind, subject, statement, status, confidence, importance, scope_id, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "legacy-item-1",
        "playbook",
        "Test Playbook",
        "Do the thing correctly",
        "active",
        0.9,
        0.8,
        "default",
        1700000000000,
      );

      // Clear the checkpoint so the migration re-runs
      rawRun(
        "DELETE FROM memory_checkpoints WHERE key = ?",
        MIGRATE_ITEMS_CHECKPOINT,
      );

      // Run migration
      migrateToolCreatedItems();

      // Assert a corresponding graph node was created
      const node = rawGet<{
        id: string;
        content: string;
        type: string;
        source_conversations: string;
        image_refs: string | null;
      }>(
        `SELECT id, content, type, source_conversations, image_refs
         FROM memory_graph_nodes
         WHERE source_conversations LIKE ?`,
        "%playbook:legacy-item-1%",
      );

      expect(node).not.toBeNull();
      expect(node!.content).toBe("Test Playbook\nDo the thing correctly");
      expect(node!.type).toBe("semantic");
      expect(JSON.parse(node!.source_conversations)).toContain(
        "playbook:legacy-item-1",
      );
      expect(node!.image_refs).toBeNull();
    } finally {
      // Clean up the recreated table so it does not interfere with other tests
      rawRun("DROP TABLE IF EXISTS memory_items");
    }
  });

  test("succeeds when image_refs column does not exist", () => {
    // This is the regression test for the v0.6.0 bug: when upgrading from
    // v0.5.x, migrateToolCreatedItems ran before the image_refs column was
    // added by migration 205, causing a crash.

    // Recreate memory_items for legacy data
    rawRun(
      `CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        statement TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL,
        scope_id TEXT NOT NULL DEFAULT 'default',
        first_seen_at INTEGER NOT NULL,
        fingerprint TEXT NOT NULL DEFAULT ''
      )`,
    );

    try {
      // Rebuild memory_graph_nodes WITHOUT the image_refs column to simulate
      // the pre-205 schema. SQLite doesn't support DROP COLUMN on all
      // versions, so we use the standard CREATE-new/INSERT-SELECT/DROP-old/
      // RENAME pattern.
      rawRun(`CREATE TABLE memory_graph_nodes_backup AS
        SELECT
          id, content, type, created, last_accessed, last_consolidated,
          event_date, emotional_charge, fidelity, confidence, significance,
          stability, reinforcement_count, last_reinforced,
          source_conversations, source_type, narrative_role, part_of_story,
          scope_id
        FROM memory_graph_nodes`);
      rawRun("DROP TABLE memory_graph_nodes");
      rawRun(
        `CREATE TABLE memory_graph_nodes (
          id                    TEXT PRIMARY KEY,
          content               TEXT NOT NULL,
          type                  TEXT NOT NULL,
          created               INTEGER NOT NULL,
          last_accessed         INTEGER NOT NULL,
          last_consolidated     INTEGER NOT NULL,
          event_date            INTEGER,
          emotional_charge      TEXT NOT NULL,
          fidelity              TEXT NOT NULL DEFAULT 'vivid',
          confidence            REAL NOT NULL,
          significance          REAL NOT NULL,
          stability             REAL NOT NULL DEFAULT 14,
          reinforcement_count   INTEGER NOT NULL DEFAULT 0,
          last_reinforced       INTEGER NOT NULL,
          source_conversations  TEXT NOT NULL DEFAULT '[]',
          source_type           TEXT NOT NULL DEFAULT 'inferred',
          narrative_role        TEXT,
          part_of_story         TEXT,
          scope_id              TEXT NOT NULL DEFAULT 'default'
        )`,
      );
      rawRun(
        `INSERT INTO memory_graph_nodes
         SELECT * FROM memory_graph_nodes_backup`,
      );
      rawRun("DROP TABLE memory_graph_nodes_backup");

      // Clear checkpoint
      rawRun(
        "DELETE FROM memory_checkpoints WHERE key = ?",
        MIGRATE_ITEMS_CHECKPOINT,
      );

      // Insert a legacy item
      rawRun(
        `INSERT INTO memory_items (id, kind, subject, statement, status, confidence, importance, scope_id, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "legacy-item-2",
        "style",
        "Formal tone",
        "Always use formal language",
        "active",
        0.85,
        0.7,
        "default",
        1700000000000,
      );

      // This should NOT throw — the migration should succeed without image_refs
      expect(() => migrateToolCreatedItems()).not.toThrow();

      // Verify the row was migrated
      const node = rawGet<{ id: string; content: string }>(
        `SELECT id, content FROM memory_graph_nodes
         WHERE source_conversations LIKE ?`,
        "%style:legacy-item-2%",
      );
      expect(node).not.toBeNull();
      expect(node!.content).toBe("Formal tone: Always use formal language");
    } finally {
      rawRun("DROP TABLE IF EXISTS memory_items");
      // Restore the full schema for subsequent tests by re-adding image_refs
      try {
        rawRun("ALTER TABLE memory_graph_nodes ADD COLUMN image_refs TEXT");
      } catch {
        // Column may already exist
      }
    }
  });

  test("skips migration when checkpoint is already set", () => {
    // Recreate memory_items for legacy data
    rawRun(
      `CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        statement TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL,
        scope_id TEXT NOT NULL DEFAULT 'default',
        first_seen_at INTEGER NOT NULL,
        fingerprint TEXT NOT NULL DEFAULT ''
      )`,
    );

    try {
      // Set the checkpoint BEFORE inserting data — the migration should skip
      setMemoryCheckpoint(MIGRATE_ITEMS_CHECKPOINT, "done");

      rawRun(
        `INSERT INTO memory_items (id, kind, subject, statement, status, confidence, importance, scope_id, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "legacy-item-3",
        "relationship",
        "Colleague",
        "Works with user on project X",
        "active",
        0.75,
        0.6,
        "default",
        1700000000000,
      );

      // Run migration — should be a no-op because checkpoint is set
      migrateToolCreatedItems();

      // Assert no rows were inserted into memory_graph_nodes
      const rows = rawAll<{ id: string }>("SELECT id FROM memory_graph_nodes");
      expect(rows).toHaveLength(0);
    } finally {
      rawRun("DROP TABLE IF EXISTS memory_items");
    }
  });

  test("handles missing memory_items table gracefully", () => {
    // Ensure memory_items table does not exist
    rawRun("DROP TABLE IF EXISTS memory_items");

    // Clear the checkpoint so migration attempts to run
    rawRun(
      "DELETE FROM memory_checkpoints WHERE key = ?",
      MIGRATE_ITEMS_CHECKPOINT,
    );

    // Should not throw even though the table doesn't exist
    expect(() => migrateToolCreatedItems()).not.toThrow();

    // The checkpoint should be set to "done" (migration handled the missing table)
    const checkpoint = rawGet<{ value: string }>(
      "SELECT value FROM memory_checkpoints WHERE key = ?",
      MIGRATE_ITEMS_CHECKPOINT,
    );
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.value).toBe("done");
  });
});
