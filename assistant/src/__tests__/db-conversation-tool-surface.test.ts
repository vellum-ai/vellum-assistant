/**
 * Tests for the per-conversation wire surface record
 * (`persistence/conversation-tool-surface.ts`): the send-boundary recorder
 * stores the tools array a live turn sends with the delegation-section state
 * its prompt rendered, fork wakes read both back verbatim, and an unchanged
 * surface is never rewritten.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import {
  getConversationToolSurface as getConversationToolSurfaceViaPluginApi,
  getRecordedConversationToolSurface,
} from "../persistence/conversation-plugin-facade.js";
import {
  type ConversationToolSurface,
  getConversationToolSurface,
  hashConversationToolSurface,
  recordConversationToolSurface,
} from "../persistence/conversation-tool-surface.js";
import { clearStoredDb, setStoredDb } from "../persistence/db-singleton.js";
import { migrateCreateConversationToolSurfaces } from "../persistence/migrations/378-create-conversation-tool-surfaces.js";
import { migrateConversationToolSurfacesDelegateIndependentTasks } from "../persistence/migrations/380-conversation-tool-surfaces-delegate-independent-tasks.js";
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
  migrateConversationToolSurfacesDelegateIndependentTasks(db);
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

const SURFACE: ConversationToolSurface = {
  tools: TOOLS,
  delegateIndependentTasks: true,
};

function storedRow(): { tools_hash: string; updated_at: number } | null {
  return sqlite
    .query(
      `SELECT tools_hash, updated_at FROM conversation_tool_surfaces WHERE conversation_id = ?`,
    )
    .get("conv-1") as { tools_hash: string; updated_at: number } | null;
}

describe("recordConversationToolSurface", () => {
  test("stores the surface and returns its content hash", () => {
    const hash = recordConversationToolSurface("conv-1", SURFACE);

    expect(hash).toBe(hashConversationToolSurface(SURFACE));
    expect(storedRow()?.tools_hash).toBe(hash);
    expect(getConversationToolSurface("conv-1")).toEqual(SURFACE);
  });

  test("replays the exact array, including key order and extra fields", () => {
    const serverTool = {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
    } as unknown as ToolDefinition;
    const tools = [...TOOLS, serverTool];

    recordConversationToolSurface("conv-1", {
      tools,
      delegateIndependentTasks: false,
    });

    expect(JSON.stringify(getConversationToolSurface("conv-1")?.tools)).toBe(
      JSON.stringify(tools),
    );
  });

  test("the delegation-section state round-trips, unknown included", () => {
    for (const delegateIndependentTasks of [true, false, null]) {
      recordConversationToolSurface("conv-1", {
        tools: TOOLS,
        delegateIndependentTasks,
      });

      expect(
        getConversationToolSurface("conv-1")?.delegateIndependentTasks,
      ).toBe(delegateIndependentTasks);
    }
  });

  test("an unchanged surface with a known hash skips the write", () => {
    const hash = recordConversationToolSurface("conv-1", SURFACE);
    const before = storedRow()!.updated_at;
    sqlite
      .query(
        `UPDATE conversation_tool_surfaces SET updated_at = ? WHERE conversation_id = ?`,
      )
      .run(before - 1000, "conv-1");

    recordConversationToolSurface("conv-1", SURFACE, hash);

    expect(storedRow()!.updated_at).toBe(before - 1000);
  });

  test("an unchanged surface with no known hash compares against the stored row before writing", () => {
    recordConversationToolSurface("conv-1", SURFACE);
    const marker = 42;
    sqlite
      .query(
        `UPDATE conversation_tool_surfaces SET updated_at = ? WHERE conversation_id = ?`,
      )
      .run(marker, "conv-1");

    // A freshly loaded conversation knows no hash yet; the stored row matches,
    // so nothing is rewritten.
    recordConversationToolSurface("conv-1", SURFACE, undefined);

    expect(storedRow()!.updated_at).toBe(marker);
  });

  test("a changed array overwrites the stored surface", () => {
    const first = recordConversationToolSurface("conv-1", SURFACE);
    const changed = { ...SURFACE, tools: TOOLS.slice(0, 1) };

    const second = recordConversationToolSurface("conv-1", changed, first);

    expect(second).not.toBe(first);
    expect(storedRow()?.tools_hash).toBe(second);
    expect(getConversationToolSurface("conv-1")).toEqual(changed);
  });

  test("a change to the delegation-section state alone overwrites it too", () => {
    // The state is part of the hash: a turn whose scope flips the section
    // (a background run's allowlist after an interactive turn) records it.
    const first = recordConversationToolSurface("conv-1", SURFACE);
    const changed = { ...SURFACE, delegateIndependentTasks: false };

    const second = recordConversationToolSurface("conv-1", changed, first);

    expect(second).not.toBe(first);
    expect(storedRow()?.tools_hash).toBe(second);
    expect(getConversationToolSurface("conv-1")).toEqual(changed);
  });

  test("a row recorded before the state existed reads unknown and is replaced on the next record", () => {
    sqlite
      .query(
        /*sql*/ `INSERT INTO conversation_tool_surfaces (conversation_id, tools_json, tools_hash, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run("conv-1", JSON.stringify(TOOLS), "pre-upgrade-hash", 1);

    expect(getConversationToolSurface("conv-1")).toEqual({
      tools: TOOLS,
      delegateIndependentTasks: null,
    });

    // The stored hash predates the state, so the next live turn's record
    // rewrites the row with it.
    const hash = recordConversationToolSurface("conv-1", SURFACE, undefined);

    expect(storedRow()?.tools_hash).toBe(hash);
    expect(getConversationToolSurface("conv-1")).toEqual(SURFACE);
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
    recordConversationToolSurface("conv-1", SURFACE);

    sqlite.query(`DELETE FROM conversations WHERE id = ?`).run("conv-1");

    expect(getConversationToolSurface("conv-1")).toBeNull();
  });
});

describe("plugin facade", () => {
  test("the array accessor is a projection of the recorded surface", async () => {
    expect(await getConversationToolSurfaceViaPluginApi("conv-1")).toBeNull();
    expect(await getRecordedConversationToolSurface("conv-1")).toBeNull();

    recordConversationToolSurface("conv-1", SURFACE);

    expect(await getRecordedConversationToolSurface("conv-1")).toEqual(SURFACE);
    // The array shape the public `@vellumai/plugin-api` accessor returns.
    expect(await getConversationToolSurfaceViaPluginApi("conv-1")).toEqual(
      TOOLS,
    );
  });
});
