import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../db-connection.js";
import * as schema from "../schema.js";
import { migrateDeleteNonDefaultMemoryScopes } from "./323-delete-non-default-memory-scopes.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function bootstrapTables(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE memory_graph_nodes (
      id                    TEXT PRIMARY KEY,
      content               TEXT NOT NULL,
      type                  TEXT NOT NULL,
      created               INTEGER NOT NULL,
      last_accessed         INTEGER NOT NULL,
      last_consolidated     INTEGER NOT NULL,
      emotional_charge      TEXT NOT NULL,
      fidelity              TEXT NOT NULL DEFAULT 'vivid',
      confidence            REAL NOT NULL,
      significance          REAL NOT NULL,
      stability             REAL NOT NULL DEFAULT 14,
      reinforcement_count   INTEGER NOT NULL DEFAULT 0,
      last_reinforced       INTEGER NOT NULL,
      source_conversations  TEXT NOT NULL DEFAULT '[]',
      source_type           TEXT NOT NULL DEFAULT 'inferred',
      scope_id              TEXT NOT NULL DEFAULT 'default',
      event_date            INTEGER,
      image_refs            TEXT
    );

    CREATE TABLE memory_graph_edges (
      id              TEXT PRIMARY KEY,
      source_node_id  TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      target_node_id  TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      relationship    TEXT NOT NULL,
      weight          REAL NOT NULL DEFAULT 1.0,
      created         INTEGER NOT NULL
    );

    CREATE TABLE conversation_starters (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      prompt TEXT NOT NULL,
      generation_batch INTEGER NOT NULL,
      scope_id TEXT NOT NULL DEFAULT 'default',
      card_type TEXT NOT NULL DEFAULT 'chip',
      created_at INTEGER NOT NULL
    );
  `);
}

function seedRows(raw: Database, now: number): void {
  raw.exec(/*sql*/ `
    INSERT INTO memory_graph_nodes (
      id, content, type, created, last_accessed, last_consolidated,
      emotional_charge, fidelity, confidence, significance, stability,
      reinforcement_count, last_reinforced, source_conversations, source_type,
      scope_id
    ) VALUES
      ('node-default', 'default node', 'semantic', ${now}, ${now}, ${now}, '{"kind":"neutral","intensity":0}', 'vivid', 0.9, 0.8, 14, 0, ${now}, '[]', 'inferred', 'default'),
      ('node-subagent', 'subagent node', 'semantic', ${now}, ${now}, ${now}, '{"kind":"neutral","intensity":0}', 'vivid', 0.9, 0.8, 14, 0, ${now}, '[]', 'inferred', 'subagent:abc'),
      ('node-background', 'background node', 'semantic', ${now}, ${now}, ${now}, '{"kind":"neutral","intensity":0}', 'vivid', 0.9, 0.8, 14, 0, ${now}, '[]', 'inferred', 'background:conv-1');

    INSERT INTO memory_graph_edges (id, source_node_id, target_node_id, relationship, weight, created)
    VALUES ('edge-subagent', 'node-subagent', 'node-default', 'reminds-of', 1.0, ${now});

    INSERT INTO conversation_starters (id, label, prompt, generation_batch, scope_id, card_type, created_at)
    VALUES
      ('starter-default', 'Default', 'Default', 1, 'default', 'chip', ${now}),
      ('starter-subagent', 'Subagent', 'Subagent', 1, 'subagent:abc', 'chip', ${now});
  `);
}

function ids(raw: Database, table: string): string[] {
  return (
    raw.query(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{
      id: string;
    }>
  ).map((row) => row.id);
}

describe("migrateDeleteNonDefaultMemoryScopes", () => {
  test("deletes non-default scope rows while preserving default rows", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapTables(raw);
    seedRows(raw, now);

    migrateDeleteNonDefaultMemoryScopes(db);

    expect(ids(raw, "memory_graph_nodes")).toEqual(["node-default"]);
    expect(ids(raw, "conversation_starters")).toEqual(["starter-default"]);
    // Deleting the subagent node cascades to its edge.
    expect(ids(raw, "memory_graph_edges")).toEqual([]);
  });

  test("is idempotent", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapTables(raw);
    seedRows(raw, now);

    migrateDeleteNonDefaultMemoryScopes(db);
    migrateDeleteNonDefaultMemoryScopes(db);

    expect(ids(raw, "memory_graph_nodes")).toEqual(["node-default"]);
    expect(ids(raw, "conversation_starters")).toEqual(["starter-default"]);
  });

  test("tolerates a missing table", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    // Only create conversation_starters — memory_graph_nodes is absent.
    raw.exec(/*sql*/ `
      CREATE TABLE conversation_starters (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        prompt TEXT NOT NULL,
        generation_batch INTEGER NOT NULL,
        scope_id TEXT NOT NULL DEFAULT 'default',
        card_type TEXT NOT NULL DEFAULT 'chip',
        created_at INTEGER NOT NULL
      );
      INSERT INTO conversation_starters (id, label, prompt, generation_batch, scope_id, card_type, created_at)
      VALUES
        ('starter-default', 'Default', 'Default', 1, 'default', 'chip', ${now}),
        ('starter-subagent', 'Subagent', 'Subagent', 1, 'subagent:abc', 'chip', ${now});
    `);

    expect(() => migrateDeleteNonDefaultMemoryScopes(db)).not.toThrow();
    expect(ids(raw, "conversation_starters")).toEqual(["starter-default"]);
  });
});
