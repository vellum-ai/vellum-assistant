/**
 * Tests for the per-conversation wire tool-surface record
 * (`persistence/conversation-tool-surface.ts`): the resolver records the
 * tools array a live turn sends, fork wakes read it back verbatim, and an
 * unchanged surface is never rewritten.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import {
  getConversationToolSurface,
  hashConversationToolSurface,
  recordConversationToolSurface,
} from "../persistence/conversation-tool-surface.js";
import { clearStoredDb, setStoredDb } from "../persistence/db-singleton.js";
import { migrateCreateConversationToolSurfaces } from "../persistence/migrations/378-create-conversation-tool-surfaces.js";
import * as schema from "../persistence/schema/index.js";
import type { ToolDefinition } from "../providers/types.js";

let sqlite: Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run(/*sql*/ `CREATE TABLE conversations (id TEXT PRIMARY KEY)`);
  sqlite.query(`INSERT INTO conversations (id) VALUES (?)`).run("conv-1");
  const db = drizzle(sqlite, { schema });
  migrateCreateConversationToolSurfaces(db);
  setStoredDb("main", db, () => sqlite.close());
});

afterEach(() => {
  clearStoredDb("main");
});

const TOOLS: ToolDefinition[] = [
  {
    name: "remember",
    description: "Save a fact",
    input_schema: { type: "object", properties: { content: {} } },
  },
  { name: "bell_jingle", description: "Ring", input_schema: {} },
];

function storedRow(): { tools_hash: string; updated_at: number } | null {
  return sqlite
    .query(
      `SELECT tools_hash, updated_at FROM conversation_tool_surfaces WHERE conversation_id = ?`,
    )
    .get("conv-1") as { tools_hash: string; updated_at: number } | null;
}

describe("recordConversationToolSurface", () => {
  test("stores the array and returns its content hash", () => {
    const hash = recordConversationToolSurface("conv-1", TOOLS);

    expect(hash).toBe(hashConversationToolSurface(TOOLS));
    expect(storedRow()?.tools_hash).toBe(hash);
    expect(getConversationToolSurface("conv-1")).toEqual(TOOLS);
  });

  test("replays the exact array, including key order and extra fields", () => {
    const serverTool = {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
    } as unknown as ToolDefinition;
    const tools = [...TOOLS, serverTool];

    recordConversationToolSurface("conv-1", tools);

    expect(JSON.stringify(getConversationToolSurface("conv-1"))).toBe(
      JSON.stringify(tools),
    );
  });

  test("an unchanged surface with a known hash skips the write", () => {
    const hash = recordConversationToolSurface("conv-1", TOOLS);
    const before = storedRow()!.updated_at;
    sqlite
      .query(
        `UPDATE conversation_tool_surfaces SET updated_at = ? WHERE conversation_id = ?`,
      )
      .run(before - 1000, "conv-1");

    recordConversationToolSurface("conv-1", TOOLS, hash);

    expect(storedRow()!.updated_at).toBe(before - 1000);
  });

  test("an unchanged surface with no known hash compares against the stored row before writing", () => {
    recordConversationToolSurface("conv-1", TOOLS);
    const marker = 42;
    sqlite
      .query(
        `UPDATE conversation_tool_surfaces SET updated_at = ? WHERE conversation_id = ?`,
      )
      .run(marker, "conv-1");

    // A freshly loaded conversation knows no hash yet; the stored row matches,
    // so nothing is rewritten.
    recordConversationToolSurface("conv-1", TOOLS, undefined);

    expect(storedRow()!.updated_at).toBe(marker);
  });

  test("a changed surface overwrites the stored one", () => {
    const first = recordConversationToolSurface("conv-1", TOOLS);
    const changed = TOOLS.slice(0, 1);

    const second = recordConversationToolSurface("conv-1", changed, first);

    expect(second).not.toBe(first);
    expect(storedRow()?.tools_hash).toBe(second);
    expect(getConversationToolSurface("conv-1")).toEqual(changed);
  });
});

describe("getConversationToolSurface", () => {
  test("returns null when no turn has recorded a surface", () => {
    expect(getConversationToolSurface("conv-1")).toBeNull();
  });

  test("returns null for an unreadable stored payload", () => {
    sqlite
      .query(
        /*sql*/ `INSERT INTO conversation_tool_surfaces (conversation_id, tools_json, tools_hash, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run("conv-1", "not json", "h", 1);

    expect(getConversationToolSurface("conv-1")).toBeNull();
  });

  test("the row cascades with its conversation", () => {
    recordConversationToolSurface("conv-1", TOOLS);

    sqlite.query(`DELETE FROM conversations WHERE id = ?`).run("conv-1");

    expect(getConversationToolSurface("conv-1")).toBeNull();
  });
});
