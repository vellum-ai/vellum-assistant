/**
 * Tests for the monitor-side read of in-flight conversations. A minimal
 * conversations table (the columns the query touches) is created in the
 * per-test workspace database via a separate writer connection; the module
 * under test reads it through its own read-only connection.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { getDbPath } from "../../util/platform.js";
import { readActiveConversations } from "../active-conversations.js";

function openWriter(): Database {
  mkdirSync(dirname(getDbPath()), { recursive: true });
  const db = new Database(getDbPath());
  db.run(
    `CREATE TABLE IF NOT EXISTS conversations (
       id TEXT PRIMARY KEY,
       title TEXT,
       origin_channel TEXT,
       origin_interface TEXT,
       processing_started_at INTEGER
     )`,
  );
  return db;
}

beforeEach(() => {
  const db = openWriter();
  db.run("DELETE FROM conversations");
  db.close();
});

describe("readActiveConversations", () => {
  test("returns processing conversations, longest-running first", () => {
    const db = openWriter();
    db.run(
      "INSERT INTO conversations (id, title, origin_channel, origin_interface, processing_started_at) VALUES (?, ?, ?, ?, ?)",
      ["conv-new", "Newer turn", "slack", "web", 2_000],
    );
    db.run(
      "INSERT INTO conversations (id, title, origin_channel, origin_interface, processing_started_at) VALUES (?, ?, ?, ?, ?)",
      ["conv-old", "Memory consolidation", null, null, 1_000],
    );
    db.run(
      "INSERT INTO conversations (id, title, origin_channel, origin_interface, processing_started_at) VALUES (?, ?, ?, ?, ?)",
      ["conv-idle", "Finished turn", null, null, null],
    );
    db.close();

    expect(readActiveConversations()).toEqual([
      {
        conversationId: "conv-old",
        title: "Memory consolidation",
        originChannel: null,
        originInterface: null,
        processingStartedAt: 1_000,
      },
      {
        conversationId: "conv-new",
        title: "Newer turn",
        originChannel: "slack",
        originInterface: "web",
        processingStartedAt: 2_000,
      },
    ]);
  });

  test("truncates long titles", () => {
    const db = openWriter();
    db.run(
      "INSERT INTO conversations (id, title, processing_started_at) VALUES (?, ?, ?)",
      ["conv-long", "x".repeat(500), 1_000],
    );
    db.close();

    const active = readActiveConversations();
    expect(active![0].title).toHaveLength(80);
  });

  test("returns null when nothing is processing", () => {
    expect(readActiveConversations()).toBeNull();
  });
});
