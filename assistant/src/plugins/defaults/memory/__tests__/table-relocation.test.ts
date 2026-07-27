/**
 * Tests for the incremental table-relocation engine
 * (`migrations/helpers/relocation.ts`), driven with migration 298's
 * `MEMORY_JOBS_RELOCATION` spec.
 *
 * What this locks in:
 *   1. `stageTableForRelocation` drops an empty source, renames a populated
 *      one aside to `<table>__relocating`, and is idempotent across re-runs.
 *   2. `drainStagedTable` copies the rows worth keeping into the target file,
 *      purges the rest without copying, applies the spec's per-column
 *      transforms (`running` → `pending`), and drops the staging table — so a
 *      heavy table moves in bounded awaited batches rather than one blocking
 *      shot.
 *
 * The drain runs through `runAsyncSqlite`, which targets the memory file
 * directly (sqlite3 subprocess where available; in-process transient
 * connection otherwise) — independent of the daemon connection, which no longer
 * ATTACHes the dedicated files.
 */
import { describe, expect, test } from "bun:test";

const { getSqlite, getMemorySqlite } =
  await import("../../../../persistence/db-connection.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");
const { drainStagedTable, stageTableForRelocation } =
  await import("../../../../persistence/migrations/helpers/relocation.js");
const { MEMORY_JOBS_RELOCATION } =
  await import("../../../../persistence/migrations/298-move-memory-jobs-to-memory-db.js");
const { INJECTION_EVENTS_RELOCATION } =
  await import("../../../../persistence/migrations/326-move-injection-events-to-memory-db.js");
const { ACTIVATION_LOGS_RELOCATION } =
  await import("../../../../persistence/migrations/336-move-memory-v2-activation-logs-to-memory-db.js");
const { RECALL_LOGS_RELOCATION } =
  await import("../../../../persistence/migrations/337-move-memory-recall-logs-to-memory-db.js");
const { MEMORY_V3_SELECTIONS_RELOCATION } =
  await import("../../../../persistence/migrations/338-move-memory-v3-selections-to-memory-db.js");
const { ACTIVATION_SESSIONS_RELOCATION } =
  await import("../../../../persistence/migrations/339-move-activation-sessions-to-memory-db.js");
const { ACTIVATION_STATE_RELOCATION } =
  await import("../../../../persistence/migrations/343-move-activation-state-to-memory-db.js");
const { CONVERSATION_GRAPH_MEMORY_STATE_RELOCATION } =
  await import("../../../../persistence/migrations/344-move-conversation-graph-memory-state-to-memory-db.js");
const { MEMORY_V3_EVER_INJECTED_RELOCATION } =
  await import("../../../../persistence/migrations/345-move-memory-v3-ever-injected-to-memory-db.js");
const { MEMORY_RETROSPECTIVE_STATE_RELOCATION } =
  await import("../../../../persistence/migrations/346-move-memory-retrospective-state-to-memory-db.js");
const {
  MEMORY_GRAPH_NODES_RELOCATION,
  MEMORY_GRAPH_EDGES_RELOCATION,
  MEMORY_GRAPH_TRIGGERS_RELOCATION,
  MEMORY_GRAPH_NODE_EDITS_RELOCATION,
} =
  await import("../../../../persistence/migrations/349-move-memory-graph-tables-to-memory-db.js");

await initializeDb();

function existsInMain(name: string): boolean {
  return (
    getSqlite()
      .query(
        `SELECT name FROM main.sqlite_master WHERE type='table' AND name = ?`,
      )
      .get(name) != null
  );
}

const MEMORY_JOBS_COLUMNS = `
  id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  deferrals INTEGER NOT NULL DEFAULT 0, run_after INTEGER NOT NULL,
  last_error TEXT, started_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`;

describe("stageTableForRelocation", () => {
  test("drops an empty source and reports no drain needed", () => {
    const sqlite = getSqlite();
    sqlite.exec(`DROP TABLE IF EXISTS main.reloc_probe`);
    sqlite.exec(`DROP TABLE IF EXISTS main."reloc_probe__relocating"`);
    sqlite.exec(`CREATE TABLE main.reloc_probe (id INTEGER PRIMARY KEY)`);

    expect(stageTableForRelocation(sqlite, "reloc_probe")).toBe(false);
    expect(existsInMain("reloc_probe")).toBe(false);
    expect(existsInMain("reloc_probe__relocating")).toBe(false);
  });

  test("renames a populated source aside, idempotently", () => {
    const sqlite = getSqlite();
    sqlite.exec(`DROP TABLE IF EXISTS main.reloc_probe`);
    sqlite.exec(`DROP TABLE IF EXISTS main."reloc_probe__relocating"`);
    sqlite.exec(`CREATE TABLE main.reloc_probe (id INTEGER PRIMARY KEY)`);
    sqlite.exec(`INSERT INTO main.reloc_probe VALUES (1)`);

    expect(stageTableForRelocation(sqlite, "reloc_probe")).toBe(true);
    expect(existsInMain("reloc_probe")).toBe(false);
    expect(existsInMain("reloc_probe__relocating")).toBe(true);

    // Re-running with the staging table already present is a safe no-op.
    expect(stageTableForRelocation(sqlite, "reloc_probe")).toBe(true);
    const row = sqlite
      .query<
        { id: number },
        []
      >(`SELECT id FROM main."reloc_probe__relocating"`)
      .get();
    expect(row?.id).toBe(1);

    sqlite.exec(`DROP TABLE IF EXISTS main."reloc_probe__relocating"`);
  });
});

describe("memory_jobs drain", () => {
  test("copies pending/running rows, purges terminal rows, drops staging", async () => {
    const sqlite = getSqlite();
    const memory = getMemorySqlite()!;

    // Clean slate: empty live queue, fresh populated staging table.
    memory.exec(`DELETE FROM memory_jobs`);
    sqlite.exec(`DROP TABLE IF EXISTS main."memory_jobs__relocating"`);
    sqlite.exec(
      `CREATE TABLE main."memory_jobs__relocating" (${MEMORY_JOBS_COLUMNS})`,
    );

    const insert = sqlite.prepare(
      `INSERT INTO main."memory_jobs__relocating"
         (id, type, payload, status, run_after, created_at, updated_at)
       VALUES (?, 'embed_segment', '{}', ?, 0, 0, 0)`,
    );
    insert.run("seed-keep-1", "pending");
    insert.run("seed-keep-2", "pending");
    insert.run("seed-keep-3", "running");
    insert.run("seed-term-1", "completed");
    insert.run("seed-term-2", "completed");
    insert.run("seed-term-3", "failed");

    await drainStagedTable(sqlite, MEMORY_JOBS_RELOCATION);

    // Staging dropped.
    expect(existsInMain("memory_jobs__relocating")).toBe(false);

    // Exactly the three keepers landed in the memory database; the terminal
    // rows were purged without being copied, and the in-flight `running` row
    // was reset to `pending` so the worker can re-claim it in its new home.
    const kept = memory
      .query<
        { id: string; status: string },
        []
      >(`SELECT id, status FROM memory_jobs WHERE id LIKE 'seed-%' ORDER BY id`)
      .all();
    expect(kept).toEqual([
      { id: "seed-keep-1", status: "pending" },
      { id: "seed-keep-2", status: "pending" },
      { id: "seed-keep-3", status: "pending" },
    ]);
  });
});

describe("memory_v2_injection_events drain", () => {
  test("copies in-window rows, purges rows older than the read window, drops staging", async () => {
    const sqlite = getSqlite();
    const memory = getMemorySqlite()!;

    // Clean slate: empty live table, fresh populated staging table.
    memory.exec(`DELETE FROM memory_v2_injection_events`);
    sqlite.exec(
      `DROP TABLE IF EXISTS main."memory_v2_injection_events__relocating"`,
    );
    sqlite.exec(/*sql*/ `
      CREATE TABLE main."memory_v2_injection_events__relocating" (
        id INTEGER PRIMARY KEY, slug TEXT NOT NULL, injected_at INTEGER NOT NULL
      )
    `);

    const now = Date.now();
    const readWindowMs = 18 * 24 * 60 * 60 * 1000; // 6 half-lives of 3 days
    const insert = sqlite.prepare(
      `INSERT INTO main."memory_v2_injection_events__relocating"
         (id, slug, injected_at) VALUES (?, ?, ?)`,
    );
    insert.run(1, "fresh-a", now - 1000);
    insert.run(2, "fresh-b", now - readWindowMs / 2);
    insert.run(3, "stale-a", now - readWindowMs - 24 * 60 * 60 * 1000);
    insert.run(4, "stale-b", now - 2 * readWindowMs);

    await drainStagedTable(sqlite, INJECTION_EVENTS_RELOCATION);

    // Staging dropped.
    expect(existsInMain("memory_v2_injection_events__relocating")).toBe(false);

    // Only the in-window rows landed in the memory database, ids preserved;
    // rows past the score read window were purged without being copied.
    const kept = memory
      .query<
        { id: number; slug: string },
        []
      >(`SELECT id, slug FROM memory_v2_injection_events ORDER BY id`)
      .all();
    expect(kept).toEqual([
      { id: 1, slug: "fresh-a" },
      { id: 2, slug: "fresh-b" },
    ]);
  });
});

describe("memory_v3_selections drain", () => {
  test("copies every row (full copy) and drops staging", async () => {
    const sqlite = getSqlite();
    const memory = getMemorySqlite()!;

    // Clean slate: empty live table, fresh populated staging table with the
    // full post-283 column set.
    memory.exec(`DELETE FROM memory_v3_selections`);
    sqlite.exec(`DROP TABLE IF EXISTS main."memory_v3_selections__relocating"`);
    sqlite.exec(/*sql*/ `
      CREATE TABLE main."memory_v3_selections__relocating" (
        conversation_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        slug TEXT NOT NULL,
        source TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        message_id TEXT,
        section_ordinal INTEGER,
        section_title TEXT,
        PRIMARY KEY (conversation_id, turn, slug)
      )
    `);

    const insert = sqlite.prepare(
      `INSERT INTO main."memory_v3_selections__relocating"
         (conversation_id, turn, slug, source, pinned, created_at,
          message_id, section_ordinal, section_title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("conv-1", 1, "page-a", "needle", 0, 1_000, "msg-1", 2, "Head");
    insert.run("conv-1", 2, "page-b", "core", 1, 2_000, null, null, null);

    await drainStagedTable(sqlite, MEMORY_V3_SELECTIONS_RELOCATION);

    expect(existsInMain("memory_v3_selections__relocating")).toBe(false);

    // Both rows landed intact, secondary attributes included.
    const kept = memory
      .query(
        `SELECT conversation_id, turn, slug, source, pinned, created_at,
                message_id, section_ordinal, section_title
           FROM memory_v3_selections WHERE conversation_id = 'conv-1'
           ORDER BY turn`,
      )
      .all();
    expect(kept).toEqual([
      {
        conversation_id: "conv-1",
        turn: 1,
        slug: "page-a",
        source: "needle",
        pinned: 0,
        created_at: 1_000,
        message_id: "msg-1",
        section_ordinal: 2,
        section_title: "Head",
      },
      {
        conversation_id: "conv-1",
        turn: 2,
        slug: "page-b",
        source: "core",
        pinned: 1,
        created_at: 2_000,
        message_id: null,
        section_ordinal: null,
        section_title: null,
      },
    ]);
  });

  test("a pre-283 legacy source NULL-fills the missing columns", async () => {
    const sqlite = getSqlite();
    const memory = getMemorySqlite()!;

    // Staging table shaped like migration 268's original schema — no
    // message_id / section_ordinal / section_title columns.
    memory.exec(`DELETE FROM memory_v3_selections`);
    sqlite.exec(`DROP TABLE IF EXISTS main."memory_v3_selections__relocating"`);
    sqlite.exec(/*sql*/ `
      CREATE TABLE main."memory_v3_selections__relocating" (
        conversation_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        slug TEXT NOT NULL,
        source TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, turn, slug)
      )
    `);
    sqlite
      .prepare(
        `INSERT INTO main."memory_v3_selections__relocating"
           (conversation_id, turn, slug, source, pinned, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("conv-legacy", 7, "page-old", "needle", 0, 5_000);

    await drainStagedTable(sqlite, MEMORY_V3_SELECTIONS_RELOCATION);

    expect(existsInMain("memory_v3_selections__relocating")).toBe(false);

    const row = memory
      .query(
        `SELECT slug, created_at, message_id, section_ordinal, section_title
           FROM memory_v3_selections WHERE conversation_id = 'conv-legacy'`,
      )
      .get();
    expect(row).toEqual({
      slug: "page-old",
      created_at: 5_000,
      message_id: null,
      section_ordinal: null,
      section_title: null,
    });
  });
});

describe("activation_sessions drain", () => {
  test("copies every row and drops staging", async () => {
    const sqlite = getSqlite();
    const memory = getMemorySqlite()!;

    memory.exec(`DELETE FROM activation_sessions`);
    sqlite.exec(`DROP TABLE IF EXISTS main."activation_sessions__relocating"`);
    sqlite.exec(/*sql*/ `
      CREATE TABLE main."activation_sessions__relocating" (
        conversation_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `);
    const insert = sqlite.prepare(
      `INSERT INTO main."activation_sessions__relocating"
         (conversation_id, created_at) VALUES (?, ?)`,
    );
    insert.run("conv-a", 1_000);
    insert.run("conv-b", 2_000);

    await drainStagedTable(sqlite, ACTIVATION_SESSIONS_RELOCATION);

    expect(existsInMain("activation_sessions__relocating")).toBe(false);

    const kept = memory
      .query(
        `SELECT conversation_id, created_at FROM activation_sessions
           ORDER BY conversation_id`,
      )
      .all();
    expect(kept).toEqual([
      { conversation_id: "conv-a", created_at: 1_000 },
      { conversation_id: "conv-b", created_at: 2_000 },
    ]);
  });
});

describe("memory_v2_activation_logs drain", () => {
  test("copies every row, drops staging", async () => {
    const sqlite = getSqlite();
    const memory = getMemorySqlite()!;

    // Clean slate: empty live table, fresh populated staging table.
    memory.exec(`DELETE FROM memory_v2_activation_logs`);
    sqlite.exec(
      `DROP TABLE IF EXISTS main."memory_v2_activation_logs__relocating"`,
    );
    sqlite.exec(/*sql*/ `
      CREATE TABLE main."memory_v2_activation_logs__relocating" (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT,
        turn INTEGER NOT NULL,
        mode TEXT NOT NULL,
        concepts_json TEXT NOT NULL,
        skills_json TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    const insert = sqlite.prepare(
      `INSERT INTO main."memory_v2_activation_logs__relocating"
         (id, conversation_id, message_id, turn, mode,
          concepts_json, skills_json, config_json, created_at)
       VALUES (?, 'conv-1', ?, ?, 'router', '[]', '[]', '{}', ?)`,
    );
    insert.run("act-1", "msg-1", 1, 1_000);
    insert.run("act-2", null, 2, 2_000);

    await drainStagedTable(sqlite, ACTIVATION_LOGS_RELOCATION);

    // Staging dropped; the full-copy spec preserved every row and column.
    expect(existsInMain("memory_v2_activation_logs__relocating")).toBe(false);
    const kept = memory
      .query<
        { id: string; message_id: string | null; turn: number },
        []
      >(`SELECT id, message_id, turn FROM memory_v2_activation_logs ORDER BY id`)
      .all();
    expect(kept).toEqual([
      { id: "act-1", message_id: "msg-1", turn: 1 },
      { id: "act-2", message_id: null, turn: 2 },
    ]);
  });
});

describe("memory_recall_logs drain", () => {
  test("copies every row, NULL-fills query_context on a pre-211 source, drops staging", async () => {
    const sqlite = getSqlite();
    const memory = getMemorySqlite()!;

    // Clean slate: empty live table, fresh populated staging table shaped
    // like a legacy source that predates the query_context column.
    memory.exec(`DELETE FROM memory_recall_logs`);
    sqlite.exec(`DROP TABLE IF EXISTS main."memory_recall_logs__relocating"`);
    sqlite.exec(/*sql*/ `
      CREATE TABLE main."memory_recall_logs__relocating" (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT,
        enabled INTEGER NOT NULL,
        degraded INTEGER NOT NULL,
        provider TEXT,
        model TEXT,
        degradation_json TEXT,
        semantic_hits INTEGER NOT NULL,
        merged_count INTEGER NOT NULL,
        selected_count INTEGER NOT NULL,
        tier1_count INTEGER NOT NULL,
        tier2_count INTEGER NOT NULL,
        hybrid_search_latency_ms INTEGER NOT NULL,
        sparse_vector_used INTEGER NOT NULL,
        injected_tokens INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        top_candidates_json TEXT NOT NULL,
        injected_text TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    const insert = sqlite.prepare(
      `INSERT INTO main."memory_recall_logs__relocating"
         (id, conversation_id, message_id, enabled, degraded, semantic_hits,
          merged_count, selected_count, tier1_count, tier2_count,
          hybrid_search_latency_ms, sparse_vector_used, injected_tokens,
          latency_ms, top_candidates_json, created_at)
       VALUES (?, 'conv-1', ?, 1, 0, 3, 2, 1, 1, 0, 100, 0, 300, 150, '[]', ?)`,
    );
    insert.run("rec-1", "msg-1", 1_000);
    insert.run("rec-2", null, 2_000);

    await drainStagedTable(sqlite, RECALL_LOGS_RELOCATION);

    // Staging dropped; both rows copied with the absent legacy column
    // NULL-filled.
    expect(existsInMain("memory_recall_logs__relocating")).toBe(false);
    const kept = memory
      .query<
        { id: string; message_id: string | null; query_context: string | null },
        []
      >(`SELECT id, message_id, query_context FROM memory_recall_logs ORDER BY id`)
      .all();
    expect(kept).toEqual([
      { id: "rec-1", message_id: "msg-1", query_context: null },
      { id: "rec-2", message_id: null, query_context: null },
    ]);
  });
});

describe("activation_state drain", () => {
  test("copies every row (full copy) and drops staging", async () => {
    const sqlite = getSqlite();
    const memory = getMemorySqlite()!;

    // Clean slate: empty live table, fresh populated staging table shaped like
    // the post-241 source (no FK — the memory DB has no conversations table).
    memory.exec(`DELETE FROM activation_state`);
    sqlite.exec(`DROP TABLE IF EXISTS main."activation_state__relocating"`);
    sqlite.exec(/*sql*/ `
      CREATE TABLE main."activation_state__relocating" (
        conversation_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        ever_injected_json TEXT NOT NULL DEFAULT '[]',
        current_turn INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
    const insert = sqlite.prepare(
      `INSERT INTO main."activation_state__relocating"
         (conversation_id, message_id, state_json, ever_injected_json, current_turn, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "conv-a",
      "msg-a",
      '{"alice":0.5}',
      '[{"slug":"alice","turn":1}]',
      3,
      1_000,
    );
    insert.run("conv-b", "msg-b", "{}", "[]", 0, 2_000);

    await drainStagedTable(sqlite, ACTIVATION_STATE_RELOCATION);

    expect(existsInMain("activation_state__relocating")).toBe(false);

    const kept = memory
      .query(
        `SELECT conversation_id, message_id, state_json, ever_injected_json,
                current_turn, updated_at
           FROM activation_state WHERE conversation_id IN ('conv-a', 'conv-b')
           ORDER BY conversation_id`,
      )
      .all();
    expect(kept).toEqual([
      {
        conversation_id: "conv-a",
        message_id: "msg-a",
        state_json: '{"alice":0.5}',
        ever_injected_json: '[{"slug":"alice","turn":1}]',
        current_turn: 3,
        updated_at: 1_000,
      },
      {
        conversation_id: "conv-b",
        message_id: "msg-b",
        state_json: "{}",
        ever_injected_json: "[]",
        current_turn: 0,
        updated_at: 2_000,
      },
    ]);
  });
});

describe("conversation_graph_memory_state drain", () => {
  test("copies every row (full copy) and drops staging", async () => {
    const sqlite = getSqlite();
    const memory = getMemorySqlite()!;

    memory.exec(`DELETE FROM conversation_graph_memory_state`);
    sqlite.exec(
      `DROP TABLE IF EXISTS main."conversation_graph_memory_state__relocating"`,
    );
    sqlite.exec(/*sql*/ `
      CREATE TABLE main."conversation_graph_memory_state__relocating" (
        conversation_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const insert = sqlite.prepare(
      `INSERT INTO main."conversation_graph_memory_state__relocating"
         (conversation_id, state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run("conv-a", '{"turn":4}', 1_000, 1_500);
    insert.run("conv-b", "{}", 2_000, 2_000);

    await drainStagedTable(sqlite, CONVERSATION_GRAPH_MEMORY_STATE_RELOCATION);

    expect(existsInMain("conversation_graph_memory_state__relocating")).toBe(
      false,
    );

    const kept = memory
      .query(
        `SELECT conversation_id, state_json, created_at, updated_at
           FROM conversation_graph_memory_state
           WHERE conversation_id IN ('conv-a', 'conv-b')
           ORDER BY conversation_id`,
      )
      .all();
    expect(kept).toEqual([
      {
        conversation_id: "conv-a",
        state_json: '{"turn":4}',
        created_at: 1_000,
        updated_at: 1_500,
      },
      {
        conversation_id: "conv-b",
        state_json: "{}",
        created_at: 2_000,
        updated_at: 2_000,
      },
    ]);
  });
});

describe("memory_v3_ever_injected drain", () => {
  test("copies every row of the composite-PK table, drops staging", async () => {
    const sqlite = getSqlite();
    const memory = getMemorySqlite()!;

    // Clean slate: empty live table, fresh populated staging table.
    memory.exec(`DELETE FROM memory_v3_ever_injected`);
    sqlite.exec(
      `DROP TABLE IF EXISTS main."memory_v3_ever_injected__relocating"`,
    );
    sqlite.exec(/*sql*/ `
      CREATE TABLE main."memory_v3_ever_injected__relocating" (
        conversation_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        injected_at INTEGER NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        pruned_at INTEGER,
        PRIMARY KEY (conversation_id, slug)
      )
    `);

    const insert = sqlite.prepare(
      `INSERT INTO main."memory_v3_ever_injected__relocating"
         (conversation_id, slug, injected_at, bytes, pruned_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run("conv-1", "topics/page-a", 1_000, 100, null);
    insert.run("conv-1", "topics/page-b", 2_000, 250, 3_000);

    await drainStagedTable(sqlite, MEMORY_V3_EVER_INJECTED_RELOCATION);

    // Staging dropped; the full-copy spec preserved every row, pruned state
    // included.
    expect(existsInMain("memory_v3_ever_injected__relocating")).toBe(false);
    const kept = memory
      .query(
        `SELECT conversation_id, slug, injected_at, bytes, pruned_at
           FROM memory_v3_ever_injected WHERE conversation_id = 'conv-1'
           ORDER BY slug`,
      )
      .all();
    expect(kept).toEqual([
      {
        conversation_id: "conv-1",
        slug: "topics/page-a",
        injected_at: 1_000,
        bytes: 100,
        pruned_at: null,
      },
      {
        conversation_id: "conv-1",
        slug: "topics/page-b",
        injected_at: 2_000,
        bytes: 250,
        pruned_at: 3_000,
      },
    ]);
  });
});

describe("memory_retrospective_state drain", () => {
  test("copies every row (full copy) and drops staging", async () => {
    const sqlite = getSqlite();
    const memory = getMemorySqlite()!;

    memory.exec(`DELETE FROM memory_retrospective_state`);
    sqlite.exec(
      `DROP TABLE IF EXISTS main."memory_retrospective_state__relocating"`,
    );
    // Staging shaped like a post-281 source, including remembered_log.
    sqlite.exec(/*sql*/ `
      CREATE TABLE main."memory_retrospective_state__relocating" (
        conversation_id TEXT PRIMARY KEY,
        last_processed_message_id TEXT NOT NULL,
        last_run_at INTEGER NOT NULL,
        remembered_log TEXT
      )
    `);
    const insert = sqlite.prepare(
      `INSERT INTO main."memory_retrospective_state__relocating"
         (conversation_id, last_processed_message_id, last_run_at, remembered_log)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run("conv-1", "m1", 1_000, '["saved one"]');
    insert.run("conv-2", "", 2_000, null);

    await drainStagedTable(sqlite, MEMORY_RETROSPECTIVE_STATE_RELOCATION);

    expect(existsInMain("memory_retrospective_state__relocating")).toBe(false);
    const kept = memory
      .query(
        `SELECT conversation_id, last_processed_message_id, last_run_at, remembered_log
           FROM memory_retrospective_state
           WHERE conversation_id IN ('conv-1', 'conv-2')
           ORDER BY conversation_id`,
      )
      .all();
    expect(kept).toEqual([
      {
        conversation_id: "conv-1",
        last_processed_message_id: "m1",
        last_run_at: 1_000,
        remembered_log: '["saved one"]',
      },
      {
        conversation_id: "conv-2",
        last_processed_message_id: "",
        last_run_at: 2_000,
        remembered_log: null,
      },
    ]);
  });

  test("a pre-281 legacy source NULL-fills remembered_log", async () => {
    const sqlite = getSqlite();
    const memory = getMemorySqlite()!;

    // Staging shaped like migration 245's original schema — no remembered_log.
    memory.exec(`DELETE FROM memory_retrospective_state`);
    sqlite.exec(
      `DROP TABLE IF EXISTS main."memory_retrospective_state__relocating"`,
    );
    sqlite.exec(/*sql*/ `
      CREATE TABLE main."memory_retrospective_state__relocating" (
        conversation_id TEXT PRIMARY KEY,
        last_processed_message_id TEXT NOT NULL,
        last_run_at INTEGER NOT NULL
      )
    `);
    sqlite
      .prepare(
        `INSERT INTO main."memory_retrospective_state__relocating"
           (conversation_id, last_processed_message_id, last_run_at)
         VALUES (?, ?, ?)`,
      )
      .run("conv-legacy", "m7", 5_000);

    await drainStagedTable(sqlite, MEMORY_RETROSPECTIVE_STATE_RELOCATION);

    expect(existsInMain("memory_retrospective_state__relocating")).toBe(false);
    const row = memory
      .query(
        `SELECT last_processed_message_id, last_run_at, remembered_log
           FROM memory_retrospective_state WHERE conversation_id = 'conv-legacy'`,
      )
      .get();
    expect(row).toEqual({
      last_processed_message_id: "m7",
      last_run_at: 5_000,
      remembered_log: null,
    });
  });
});

describe("memory graph cluster drain", () => {
  test("drains nodes then children into memory, preserving the intra-cluster cascade", async () => {
    const sqlite = getSqlite();
    const memory = getMemorySqlite()!;

    // Clean slate on the memory side (children before parents — FK order), then
    // rebuild the four staging tables on main shaped like the post-205/206
    // source. Staging tables carry no FK; the cascade lives on the memory side.
    memory.exec(`DELETE FROM memory_graph_node_edits`);
    memory.exec(`DELETE FROM memory_graph_triggers`);
    memory.exec(`DELETE FROM memory_graph_edges`);
    memory.exec(`DELETE FROM memory_graph_nodes`);
    for (const t of [
      "memory_graph_nodes",
      "memory_graph_edges",
      "memory_graph_triggers",
      "memory_graph_node_edits",
    ]) {
      sqlite.exec(`DROP TABLE IF EXISTS main."${t}__relocating"`);
    }
    sqlite.exec(/*sql*/ `
      CREATE TABLE main."memory_graph_nodes__relocating" (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT NOT NULL,
        created INTEGER NOT NULL, last_accessed INTEGER NOT NULL,
        last_consolidated INTEGER NOT NULL, emotional_charge TEXT NOT NULL,
        fidelity TEXT NOT NULL DEFAULT 'vivid', confidence REAL NOT NULL,
        significance REAL NOT NULL, stability REAL NOT NULL DEFAULT 14,
        reinforcement_count INTEGER NOT NULL DEFAULT 0,
        last_reinforced INTEGER NOT NULL,
        source_conversations TEXT NOT NULL DEFAULT '[]',
        source_type TEXT NOT NULL DEFAULT 'inferred',
        narrative_role TEXT, part_of_story TEXT,
        scope_id TEXT NOT NULL DEFAULT 'default',
        event_date INTEGER, image_refs TEXT
      );
      CREATE TABLE main."memory_graph_edges__relocating" (
        id TEXT PRIMARY KEY, source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL, relationship TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0, created INTEGER NOT NULL
      );
      CREATE TABLE main."memory_graph_triggers__relocating" (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL, type TEXT NOT NULL,
        schedule TEXT, condition TEXT, condition_embedding BLOB, threshold REAL,
        event_date INTEGER, ramp_days INTEGER, follow_up_days INTEGER,
        recurring INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0,
        cooldown_ms INTEGER, last_fired INTEGER
      );
      CREATE TABLE main."memory_graph_node_edits__relocating" (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL,
        previous_content TEXT NOT NULL, new_content TEXT NOT NULL,
        source TEXT NOT NULL, conversation_id TEXT, created INTEGER NOT NULL
      );
    `);

    const insertNode = sqlite.prepare(
      `INSERT INTO main."memory_graph_nodes__relocating"
         (id, content, type, created, last_accessed, last_consolidated,
          emotional_charge, confidence, significance, last_reinforced, scope_id)
       VALUES (?, ?, 'semantic', 0, 0, 0, '{}', 0.5, 0.5, 0, 'default')`,
    );
    insertNode.run("n1", "first");
    insertNode.run("n2", "second");
    sqlite
      .prepare(
        `INSERT INTO main."memory_graph_edges__relocating"
           (id, source_node_id, target_node_id, relationship, weight, created)
         VALUES (?, ?, ?, 'reminds-of', 1.0, 0)`,
      )
      .run("e1", "n1", "n2");
    sqlite
      .prepare(
        `INSERT INTO main."memory_graph_triggers__relocating"
           (id, node_id, type, recurring, consumed)
         VALUES (?, ?, 'semantic', 0, 0)`,
      )
      .run("t1", "n1");
    sqlite
      .prepare(
        `INSERT INTO main."memory_graph_node_edits__relocating"
           (id, node_id, previous_content, new_content, source, created)
         VALUES (?, ?, 'old', 'new', 'user', 0)`,
      )
      .run("ed1", "n1");

    // Parent first, then children: draining edges/triggers/edits before nodes
    // would fail FK enforcement on the memory connection (no node to point at).
    await drainStagedTable(sqlite, MEMORY_GRAPH_NODES_RELOCATION);
    await drainStagedTable(sqlite, MEMORY_GRAPH_EDGES_RELOCATION);
    await drainStagedTable(sqlite, MEMORY_GRAPH_TRIGGERS_RELOCATION);
    await drainStagedTable(sqlite, MEMORY_GRAPH_NODE_EDITS_RELOCATION);

    for (const t of [
      "memory_graph_nodes",
      "memory_graph_edges",
      "memory_graph_triggers",
      "memory_graph_node_edits",
    ]) {
      expect(existsInMain(`${t}__relocating`)).toBe(false);
    }

    expect(
      memory.query(`SELECT id FROM memory_graph_nodes ORDER BY id`).all(),
    ).toEqual([{ id: "n1" }, { id: "n2" }]);
    expect(memory.query(`SELECT id FROM memory_graph_edges`).all()).toEqual([
      { id: "e1" },
    ]);
    expect(memory.query(`SELECT id FROM memory_graph_triggers`).all()).toEqual([
      { id: "t1" },
    ]);
    expect(
      memory.query(`SELECT id FROM memory_graph_node_edits`).all(),
    ).toEqual([{ id: "ed1" }]);

    // The intra-cluster ON DELETE CASCADE was recreated on the memory side and
    // the memory connection enforces foreign keys: deleting n1 removes its edge,
    // trigger, and edit, while the unrelated n2 survives.
    memory.exec(`DELETE FROM memory_graph_nodes WHERE id = 'n1'`);
    expect(
      memory.query(`SELECT id FROM memory_graph_nodes ORDER BY id`).all(),
    ).toEqual([{ id: "n2" }]);
    expect(
      memory
        .query<
          { c: number },
          []
        >(`SELECT COUNT(*) AS c FROM memory_graph_edges`)
        .get(),
    ).toEqual({ c: 0 });
    expect(
      memory
        .query<
          { c: number },
          []
        >(`SELECT COUNT(*) AS c FROM memory_graph_triggers`)
        .get(),
    ).toEqual({ c: 0 });
    expect(
      memory
        .query<
          { c: number },
          []
        >(`SELECT COUNT(*) AS c FROM memory_graph_node_edits`)
        .get(),
    ).toEqual({ c: 0 });
  });
});
