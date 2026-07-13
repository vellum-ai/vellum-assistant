/**
 * Tests for migration 334: backfilling unshipped rows from the six legacy
 * per-type telemetry tables into the generic `telemetry_events` outbox,
 * dropping the legacy tables, and purging their `flush_checkpoints`
 * watermarks.
 *
 * Runs against real workspace databases (`initializeDb()` already ran the
 * step once, dropping the empty legacy tables), so each test recreates the
 * legacy tables via raw SQL to simulate an upgrading install with pending
 * rows.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getTelemetrySqlite } = await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { migrateBackfillTelemetryEventsOutbox } =
  await import("./334-backfill-telemetry-events-outbox.js");
const { APP_VERSION } = await import("../../version.js");

await initializeDb();

const OPT_OUT_SENTINEL = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const LEGACY_TABLES: Record<string, string> = {
  lifecycle_events: /*sql*/ `
    id TEXT PRIMARY KEY, event_name TEXT NOT NULL, created_at INTEGER NOT NULL`,
  onboarding_events: /*sql*/ `
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, screen TEXT NOT NULL,
    tools_json TEXT, tasks_json TEXT, tone TEXT, google_connected INTEGER,
    google_scopes_json TEXT, prior_assistants_json TEXT, ab_variant TEXT,
    session_id TEXT, step_name TEXT, step_index INTEGER, completed_at TEXT,
    funnel_version TEXT`,
  auth_fallback_events: /*sql*/ `
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, guard TEXT NOT NULL,
    path TEXT NOT NULL, failure_kind TEXT NOT NULL, count INTEGER NOT NULL,
    window_start INTEGER NOT NULL, window_end INTEGER NOT NULL`,
  skill_loaded_events: /*sql*/ `
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, conversation_id TEXT,
    skill_name TEXT NOT NULL, skill_updated_at TEXT, provider TEXT, model TEXT,
    inference_profile TEXT, inference_profile_source TEXT`,
  watchdog_events: /*sql*/ `
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, check_name TEXT NOT NULL,
    value REAL, detail TEXT`,
  config_setting_events: /*sql*/ `
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, config_key TEXT NOT NULL,
    config_value TEXT NOT NULL`,
};

const SOURCE_IDS = [
  "lifecycle",
  "onboarding",
  "auth_fallback",
  "skill_loaded",
  "watchdog",
  "config_setting",
];

const WATERMARK_KEYS = SOURCE_IDS.flatMap((sourceId) => [
  `telemetry:${sourceId}:last_reported_at`,
  `telemetry:${sourceId}:last_reported_id`,
]);

function telemetry() {
  return getTelemetrySqlite()!;
}

function resetState(): void {
  for (const table of Object.keys(LEGACY_TABLES)) {
    telemetry().exec(`DROP TABLE IF EXISTS ${table}`);
  }
  telemetry().exec(`DELETE FROM telemetry_events`);
  telemetry()
    .query(
      `DELETE FROM flush_checkpoints WHERE key IN (${WATERMARK_KEYS.map(() => "?").join(", ")})`,
    )
    .run(...WATERMARK_KEYS);
}

function createLegacyTable(table: string): void {
  telemetry().exec(`CREATE TABLE ${table} (${LEGACY_TABLES[table]})`);
}

function setWatermark(sourceId: string, at: number, id?: string): void {
  const insert = telemetry().prepare(
    `INSERT INTO flush_checkpoints (key, value, updated_at) VALUES (?, ?, ?)`,
  );
  insert.run(`telemetry:${sourceId}:last_reported_at`, String(at), Date.now());
  if (id !== undefined) {
    insert.run(`telemetry:${sourceId}:last_reported_id`, id, Date.now());
  }
}

function tableExists(table: string): boolean {
  return (
    telemetry()
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table) != null
  );
}

function outboxRows(name: string): Array<{
  id: string;
  created_at: number;
  conversation_id: string | null;
  payload: Record<string, unknown>;
}> {
  return (
    telemetry()
      .query(
        `SELECT id, created_at, conversation_id, payload FROM telemetry_events
         WHERE name = ? ORDER BY created_at, id`,
      )
      .all(name) as Array<{
      id: string;
      created_at: number;
      conversation_id: string | null;
      payload: string;
    }>
  ).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

function watermarkKeyCount(): number {
  return (
    telemetry()
      .query(
        `SELECT COUNT(*) AS n FROM flush_checkpoints
         WHERE key IN (${WATERMARK_KEYS.map(() => "?").join(", ")})`,
      )
      .get(...WATERMARK_KEYS) as { n: number }
  ).n;
}

describe("migration 334: backfill telemetry_events from the legacy tables", () => {
  test("initializeDb leaves telemetry_events and none of the legacy tables", () => {
    expect(tableExists("telemetry_events")).toBe(true);
    for (const table of Object.keys(LEGACY_TABLES)) {
      expect(tableExists(table)).toBe(false);
    }
  });

  test("compound watermark: only rows past (at, id) backfill; payload is the frozen wire shape", () => {
    resetState();
    createLegacyTable("lifecycle_events");
    const insert = telemetry().prepare(
      `INSERT INTO lifecycle_events (id, event_name, created_at) VALUES (?, ?, ?)`,
    );
    insert.run("shipped-1", "app_open", 1000);
    insert.run("aaa-at-watermark", "hatch", 2000); // id <= watermark id at equal timestamp
    insert.run("zzz-at-watermark", "app_open", 2000); // id > watermark id at equal timestamp
    insert.run("unshipped-1", "conversations_clear_all", 3000);
    setWatermark("lifecycle", 2000, "aaa-at-watermark");

    migrateBackfillTelemetryEventsOutbox(getDb());

    const rows = outboxRows("lifecycle");
    expect(rows.map((r) => r.id)).toEqual(["zzz-at-watermark", "unshipped-1"]);
    expect(rows[0]!.created_at).toBe(2000);
    expect(rows[0]!.conversation_id).toBeNull();
    expect(rows[0]!.payload).toEqual({
      type: "lifecycle",
      daemon_event_id: "zzz-at-watermark",
      event_name: "app_open",
      recorded_at: 2000,
      assistant_version: APP_VERSION,
    });
    expect(tableExists("lifecycle_events")).toBe(false);
  });

  test("opt-out id sentinel: rows at the pinned timestamp stay shipped, later rows backfill", () => {
    resetState();
    createLegacyTable("config_setting_events");
    const insert = telemetry().prepare(
      `INSERT INTO config_setting_events (id, created_at, config_key, config_value)
       VALUES (?, ?, ?, ?)`,
    );
    // Hex UUID-shaped ids: every real row id sorts below the ffffffff-… sentinel.
    insert.run("ab12cd34-pinned", 2000, "memory.enabled", "true");
    insert.run("ef56ab78-after-optout", 2001, "memory.enabled", "false");
    setWatermark("config_setting", 2000, OPT_OUT_SENTINEL);

    migrateBackfillTelemetryEventsOutbox(getDb());

    const rows = outboxRows("config_setting");
    expect(rows.map((r) => r.id)).toEqual(["ef56ab78-after-optout"]);
    expect(rows[0]!.payload).toEqual({
      type: "config_setting",
      daemon_event_id: "ef56ab78-after-optout",
      recorded_at: 2001,
      config_key: "memory.enabled",
      config_value: "false",
      assistant_version: APP_VERSION,
    });
  });

  test("timestamp-only watermark (no id key) filters on created_at alone", () => {
    resetState();
    createLegacyTable("auth_fallback_events");
    const insert = telemetry().prepare(
      `INSERT INTO auth_fallback_events
         (id, created_at, guard, path, failure_kind, count, window_start, window_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "shipped-1",
      1000,
      "edge",
      "/v1/messages",
      "missing_authorization",
      7,
      900,
      1000,
    );
    insert.run(
      "at-watermark",
      2000,
      "edge-scoped",
      "/v1/files",
      "insufficient_scope",
      2,
      1900,
      2000,
    );
    insert.run(
      "unshipped-1",
      3000,
      "edge-guardian",
      "/v1/pair",
      "guardian_mismatch",
      1,
      2900,
      3000,
    );
    setWatermark("auth_fallback", 2000);

    migrateBackfillTelemetryEventsOutbox(getDb());

    const rows = outboxRows("auth_fallback");
    expect(rows.map((r) => r.id)).toEqual(["unshipped-1"]);
    expect(rows[0]!.payload).toEqual({
      type: "auth_fallback",
      daemon_event_id: "unshipped-1",
      recorded_at: 3000,
      guard: "edge-guardian",
      path: "/v1/pair",
      failure_kind: "guardian_mismatch",
      count: 1,
      window_start: 2900,
      window_end: 3000,
      assistant_version: APP_VERSION,
    });
  });

  test("absent watermark backfills ALL rows; corrupt watchdog detail becomes null", () => {
    resetState();
    createLegacyTable("watchdog_events");
    const insert = telemetry().prepare(
      `INSERT INTO watchdog_events (id, created_at, check_name, value, detail)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run(
      "wd-1",
      1000,
      "event_loop_block",
      250.5,
      '{"reason":"gc","secondary":2}',
    );
    insert.run("wd-corrupt", 2000, "stream_idle", null, "{not json");
    insert.run("wd-nonobject", 3000, "restart", 1, "42");

    migrateBackfillTelemetryEventsOutbox(getDb());

    const rows = outboxRows("watchdog");
    expect(rows.map((r) => r.id)).toEqual([
      "wd-1",
      "wd-corrupt",
      "wd-nonobject",
    ]);
    expect(rows[0]!.payload).toEqual({
      type: "watchdog",
      daemon_event_id: "wd-1",
      recorded_at: 1000,
      check_name: "event_loop_block",
      value: 250.5,
      detail: { reason: "gc", secondary: 2 },
      assistant_version: APP_VERSION,
    });
    expect(rows[1]!.payload.detail).toBeNull();
    expect(rows[2]!.payload.detail).toBeNull();
  });

  test("onboarding: activation daemon_event_id override, omit-when-absent fields, corrupt JSON column omitted", () => {
    resetState();
    createLegacyTable("onboarding_events");
    const insert = telemetry().prepare(
      `INSERT INTO onboarding_events
         (id, created_at, screen, tools_json, tasks_json, tone, google_connected,
          google_scopes_json, prior_assistants_json, ab_variant, session_id,
          step_name, step_index, completed_at, funnel_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "ob-full",
      1000,
      "tools",
      '["calendar","email"]',
      '["plan-day"]',
      "warm",
      0,
      '["scope-a"]',
      '["other"]',
      "variant-b",
      null,
      null,
      null,
      null,
      null,
    );
    insert.run(
      "ob-activation",
      2000,
      "activation_moment_1_complete",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "sess-1",
      "activation_moment_1_complete",
      1,
      "2026-07-01T00:00:00.000Z",
      "v2",
    );
    insert.run(
      "ob-corrupt",
      3000,
      "tasks",
      "{not json",
      null,
      null,
      1,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );

    migrateBackfillTelemetryEventsOutbox(getDb());

    const rows = outboxRows("onboarding");
    expect(rows.map((r) => r.id)).toEqual([
      "ob-full",
      "ob-activation",
      "ob-corrupt",
    ]);
    expect(rows[0]!.payload).toEqual({
      type: "onboarding",
      daemon_event_id: "ob-full",
      recorded_at: 1000,
      screen: "tools",
      tools: ["calendar", "email"],
      tasks: ["plan-day"],
      tone: "warm",
      google_connected: false,
      google_scopes: ["scope-a"],
      ab_variant: "variant-b",
      assistant_version: APP_VERSION,
    });
    expect(rows[1]!.payload).toEqual({
      type: "onboarding",
      daemon_event_id: "v2:sess-1:activation_moment_1_complete",
      recorded_at: 2000,
      screen: "activation_moment_1_complete",
      session_id: "sess-1",
      step_name: "activation_moment_1_complete",
      step_index: 1,
      completed_at: "2026-07-01T00:00:00.000Z",
      funnel_version: "v2",
      assistant_version: APP_VERSION,
    });
    // Corrupt tools_json: the field is omitted, the row still backfills.
    expect(rows[2]!.payload).toEqual({
      type: "onboarding",
      daemon_event_id: "ob-corrupt",
      recorded_at: 3000,
      screen: "tasks",
      google_connected: true,
      assistant_version: APP_VERSION,
    });
  });

  test("skill_loaded rows carry conversation_id in the dedicated column", () => {
    resetState();
    createLegacyTable("skill_loaded_events");
    const insert = telemetry().prepare(
      `INSERT INTO skill_loaded_events
         (id, created_at, conversation_id, skill_name, skill_updated_at,
          provider, model, inference_profile, inference_profile_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "sk-1",
      1000,
      "conv-a",
      "web-research",
      "2026-06-01T00:00:00Z",
      "anthropic",
      "claude-1",
      "profile-x",
      "mix",
    );
    insert.run("sk-2", 2000, null, "tasks", null, null, null, null, null);

    migrateBackfillTelemetryEventsOutbox(getDb());

    const rows = outboxRows("skill_loaded");
    expect(rows.map((r) => r.conversation_id)).toEqual(["conv-a", null]);
    expect(rows[0]!.payload).toEqual({
      type: "skill_loaded",
      daemon_event_id: "sk-1",
      recorded_at: 1000,
      skill_name: "web-research",
      skill_updated_at: "2026-06-01T00:00:00Z",
      conversation_id: "conv-a",
      provider: "anthropic",
      model: "claude-1",
      inference_profile: "profile-x",
      inference_profile_source: "mix",
      assistant_version: APP_VERSION,
    });
    expect(rows[1]!.payload).toMatchObject({
      skill_updated_at: null,
      conversation_id: null,
      provider: null,
    });
  });

  test("drops every legacy table, purges all 12 watermark keys, and skips absent tables", () => {
    resetState();
    // Only two of the six tables exist — the rest must be skipped cleanly.
    createLegacyTable("lifecycle_events");
    createLegacyTable("watchdog_events");
    telemetry().exec(
      `INSERT INTO lifecycle_events (id, event_name, created_at) VALUES ('l-1', 'app_open', 1000)`,
    );
    setWatermark("onboarding", 5000, "some-id"); // watermark for an absent table
    setWatermark("lifecycle", 500);

    migrateBackfillTelemetryEventsOutbox(getDb());

    for (const table of Object.keys(LEGACY_TABLES)) {
      expect(tableExists(table)).toBe(false);
    }
    expect(watermarkKeyCount()).toBe(0);
    expect(outboxRows("lifecycle")).toHaveLength(1);
    expect(outboxRows("watchdog")).toHaveLength(0);
  });

  test("backfills in chunks past 500 rows", () => {
    resetState();
    createLegacyTable("lifecycle_events");
    const insert = telemetry().prepare(
      `INSERT INTO lifecycle_events (id, event_name, created_at) VALUES (?, ?, ?)`,
    );
    for (let i = 0; i < 501; i++) {
      insert.run(`bulk-${String(i).padStart(4, "0")}`, "app_open", 1000 + i);
    }

    migrateBackfillTelemetryEventsOutbox(getDb());

    expect(outboxRows("lifecycle")).toHaveLength(501);
  });

  test("re-running after completion is a safe no-op", () => {
    resetState();
    createLegacyTable("lifecycle_events");
    telemetry().exec(
      `INSERT INTO lifecycle_events (id, event_name, created_at) VALUES ('l-1', 'hatch', 1000)`,
    );

    migrateBackfillTelemetryEventsOutbox(getDb());
    migrateBackfillTelemetryEventsOutbox(getDb());

    expect(outboxRows("lifecycle")).toHaveLength(1);
    expect(watermarkKeyCount()).toBe(0);
  });

  test("a pre-existing outbox row with the same id survives (INSERT OR IGNORE)", () => {
    resetState();
    createLegacyTable("lifecycle_events");
    telemetry().exec(
      `INSERT INTO lifecycle_events (id, event_name, created_at) VALUES ('dupe-1', 'app_open', 1000)`,
    );
    telemetry().exec(
      `INSERT INTO telemetry_events (id, name, created_at, conversation_id, payload)
       VALUES ('dupe-1', 'lifecycle', 1000, NULL, '{"type":"lifecycle","already":"queued"}')`,
    );

    migrateBackfillTelemetryEventsOutbox(getDb());

    const rows = outboxRows("lifecycle");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ type: "lifecycle", already: "queued" });
  });
});
