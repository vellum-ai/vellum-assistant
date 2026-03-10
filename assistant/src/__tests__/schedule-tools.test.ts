import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "schedule-tools-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    memory: {},
  }),
}));

import type { Database } from "bun:sqlite";

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { executeScheduleCreate } from "../tools/schedule/create.js";
import { executeScheduleDelete } from "../tools/schedule/delete.js";
import { executeScheduleList } from "../tools/schedule/list.js";
import { executeScheduleUpdate } from "../tools/schedule/update.js";
import type { ToolContext } from "../tools/types.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

const ctx: ToolContext = {
  workingDir: "/tmp",
  sessionId: "test-session",
  conversationId: "test-conversation",
  trustClass: "guardian",
};

// ── schedule_create ─────────────────────────────────────────────────

describe("schedule_create tool", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("creates a schedule with valid cron expression", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Daily standup",
        expression: "0 9 * * 1-5",
        message: "Time for standup!",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("schedule created successfully");
    expect(result.content).toContain("Daily standup");
    expect(result.content).toContain("Every weekday at 9:00 AM");
    expect(result.content).toContain("Enabled: true");
  });

  test("creates a disabled schedule", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Paused job",
        expression: "0 12 * * *",
        message: "Noon check",
        enabled: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Enabled: false");
  });

  test("creates a schedule with timezone", async () => {
    const result = await executeScheduleCreate(
      {
        name: "LA morning",
        expression: "0 8 * * *",
        message: "Good morning LA",
        timezone: "America/Los_Angeles",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("America/Los_Angeles");
  });

  test("rejects missing name", async () => {
    const result = await executeScheduleCreate(
      {
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("name is required");
  });

  test("rejects missing expression when no fire_at", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Test",
        message: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("expression is required");
  });

  test("rejects missing message", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Test",
        expression: "0 9 * * *",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("message is required");
  });

  test("rejects invalid cron expression", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Bad cron",
        syntax: "cron",
        expression: "not-a-cron",
        message: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid cron expression");
  });
});

// ── schedule_create with fire_at (one-shot) ──────────────────────────

describe("schedule_create with fire_at (one-shot)", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("creates a one-shot schedule with fire_at", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const result = await executeScheduleCreate(
      {
        name: "One-time reminder",
        fire_at: futureDate,
        message: "Don't forget!",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("One-shot schedule created successfully");
    expect(result.content).toContain("Type: one-shot");
    expect(result.content).toContain("Mode: execute");
    expect(result.content).toContain("One-time reminder");
    expect(result.content).toContain("Status: active");
  });

  test("rejects fire_at that is not valid ISO 8601", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Bad date",
        fire_at: "not-a-date",
        message: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("valid ISO 8601");
  });

  test("rejects fire_at that is in the past", async () => {
    const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
    const result = await executeScheduleCreate(
      {
        name: "Past date",
        fire_at: pastDate,
        message: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("must be in the future");
  });

  test("fire_at ignores expression param when provided", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const result = await executeScheduleCreate(
      {
        name: "Fire at with expression",
        fire_at: futureDate,
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("One-shot schedule created successfully");
    expect(result.content).toContain("Type: one-shot");
  });
});

// ── schedule_create with mode and routing ──────────────────────────

describe("schedule_create with mode and routing", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("passes mode through to schedule", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Notify schedule",
        expression: "0 9 * * *",
        message: "notify test",
        mode: "notify",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Mode: notify");
  });

  test("defaults mode to execute", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Default mode",
        expression: "0 9 * * *",
        message: "default test",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Mode: execute");
  });

  test("rejects invalid mode", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Bad mode",
        expression: "0 9 * * *",
        message: "test",
        mode: "invalid",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("mode must be one of");
  });

  test("passes routing_intent and routing_hints through", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const result = await executeScheduleCreate(
      {
        name: "Routed schedule",
        fire_at: futureDate,
        message: "routed test",
        routing_intent: "single_channel",
        routing_hints: { channel: "slack" },
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("One-shot schedule created successfully");

    // Verify in DB
    const row = getRawDb()
      .query("SELECT routing_intent, routing_hints_json FROM cron_jobs LIMIT 1")
      .get() as { routing_intent: string; routing_hints_json: string };
    expect(row.routing_intent).toBe("single_channel");
    expect(JSON.parse(row.routing_hints_json)).toEqual({ channel: "slack" });
  });
});

// ── schedule_list ───────────────────────────────────────────────────

describe("schedule_list tool", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("returns empty message when no schedules exist", async () => {
    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("No schedules found");
  });

  test("lists all schedules", async () => {
    await executeScheduleCreate(
      {
        name: "Job Alpha",
        expression: "0 9 * * *",
        message: "Alpha",
      },
      ctx,
    );
    await executeScheduleCreate(
      {
        name: "Job Beta",
        expression: "0 17 * * *",
        message: "Beta",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Schedules (2)");
    expect(result.content).toContain("Job Alpha");
    expect(result.content).toContain("Job Beta");
  });

  test("filters to enabled only", async () => {
    await executeScheduleCreate(
      {
        name: "Enabled Job",
        expression: "0 9 * * *",
        message: "enabled",
      },
      ctx,
    );
    await executeScheduleCreate(
      {
        name: "Disabled Job",
        expression: "0 17 * * *",
        message: "disabled",
        enabled: false,
      },
      ctx,
    );

    const result = await executeScheduleList({ enabled_only: true }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Enabled Job");
    expect(result.content).not.toContain("Disabled Job");
  });

  test("shows detail for a specific job", async () => {
    await executeScheduleCreate(
      {
        name: "Detail Job",
        expression: "30 14 * * *",
        message: "Afternoon check",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };

    const result = await executeScheduleList({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Schedule: Detail Job");
    expect(result.content).toContain("Every day at 2:30 PM");
    expect(result.content).toContain("Message: Afternoon check");
    expect(result.content).toContain("Enabled: true");
    expect(result.content).toContain("No runs yet");
  });

  test("returns error for nonexistent job_id", async () => {
    const result = await executeScheduleList({ job_id: "nonexistent" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Schedule not found");
  });
});

// ── schedule_list with one-shot schedules ────────────────────────────

describe("schedule_list with one-shot schedules", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("shows one-shot schedule with fire time in list mode", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await executeScheduleCreate(
      {
        name: "One-shot Event",
        fire_at: futureDate,
        message: "fire test",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("One-shot Event");
    expect(result.content).toContain("one-shot");
    expect(result.content).toContain("fire at:");
    expect(result.content).toContain("active");
  });

  test("shows one-shot detail view with type and status", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await executeScheduleCreate(
      {
        name: "One-shot Detail",
        fire_at: futureDate,
        message: "detail test",
        mode: "notify",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleList({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Type: one-shot");
    expect(result.content).toContain("Mode: notify");
    expect(result.content).toContain("Status: active");
    expect(result.content).toContain("Fire at:");
  });

  test("shows mode in list output for recurring schedules", async () => {
    await executeScheduleCreate(
      {
        name: "Recurring with mode",
        expression: "0 9 * * *",
        message: "test",
        mode: "notify",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("notify");
  });

  test("shows routing intent in detail when not default", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await executeScheduleCreate(
      {
        name: "Routed One-shot",
        fire_at: futureDate,
        message: "routed test",
        routing_intent: "single_channel",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleList({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Routing: single_channel");
  });

  test("hides routing intent in detail when it is the default", async () => {
    await executeScheduleCreate(
      {
        name: "Default Routing",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleList({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("Routing:");
  });
});

// ── schedule_update ─────────────────────────────────────────────────

describe("schedule_update tool", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("updates the name of a schedule", async () => {
    await executeScheduleCreate(
      {
        name: "Old Name",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        name: "New Name",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Schedule updated successfully");
    expect(result.content).toContain("New Name");
  });

  test("updates the cron expression", async () => {
    await executeScheduleCreate(
      {
        name: "Timing Test",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        expression: "0 17 * * *",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Every day at 5:00 PM");
  });

  test("disables a schedule", async () => {
    await executeScheduleCreate(
      {
        name: "Disable Me",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        enabled: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Enabled: false");
    expect(result.content).toContain("n/a (disabled)");
  });

  test("rejects missing job_id", async () => {
    const result = await executeScheduleUpdate({ name: "test" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("job_id is required");
  });

  test("rejects update with no fields", async () => {
    await executeScheduleCreate(
      {
        name: "No Update",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate({ job_id: row.id }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("No updates provided");
  });

  test("returns error for nonexistent job_id", async () => {
    const result = await executeScheduleUpdate(
      {
        job_id: "nonexistent",
        name: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Schedule not found");
  });

  test("rejects invalid cron expression in update", async () => {
    await executeScheduleCreate(
      {
        name: "Bad Update",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        syntax: "cron",
        expression: "invalid",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid cron expression");
  });
});

// ── schedule_update with mode and routing ────────────────────────────

describe("schedule_update with mode and routing", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("updates mode", async () => {
    await executeScheduleCreate(
      {
        name: "Mode update",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        mode: "notify",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Mode: notify");
  });

  test("updates routing_intent", async () => {
    await executeScheduleCreate(
      {
        name: "Routing update",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        routing_intent: "single_channel",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Schedule updated successfully");

    // Verify in DB
    const dbRow = getRawDb()
      .query("SELECT routing_intent FROM cron_jobs WHERE id = ?")
      .get(row.id) as { routing_intent: string };
    expect(dbRow.routing_intent).toBe("single_channel");
  });

  test("updates routing_hints", async () => {
    await executeScheduleCreate(
      {
        name: "Hints update",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        routing_hints: { channel: "telegram" },
      },
      ctx,
    );

    expect(result.isError).toBe(false);

    const dbRow = getRawDb()
      .query("SELECT routing_hints_json FROM cron_jobs WHERE id = ?")
      .get(row.id) as { routing_hints_json: string };
    expect(JSON.parse(dbRow.routing_hints_json)).toEqual({
      channel: "telegram",
    });
  });

  test("rejects invalid mode", async () => {
    await executeScheduleCreate(
      {
        name: "Bad mode",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        mode: "invalid",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("mode must be one of");
  });

  test("rejects invalid routing_intent", async () => {
    await executeScheduleCreate(
      {
        name: "Bad routing",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        routing_intent: "invalid",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("routing_intent must be one of");
  });

  test("prevents changing one-shot to recurring", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await executeScheduleCreate(
      {
        name: "One-shot",
        fire_at: futureDate,
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        expression: "0 9 * * *",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Cannot change a one-shot schedule to recurring",
    );
  });

  test("prevents changing recurring to one-shot", async () => {
    await executeScheduleCreate(
      {
        name: "Recurring",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        fire_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Cannot change a recurring schedule to one-shot",
    );
  });
});

// ── RRULE support in schedule tools ─────────────────────────────────

describe("schedule_create with RRULE", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("creates a schedule with RRULE syntax + expression", async () => {
    const result = await executeScheduleCreate(
      {
        name: "RRULE daily",
        syntax: "rrule",
        expression: "DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY",
        message: "RRULE test",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("schedule created successfully");
    expect(result.content).toContain("Syntax: rrule");
    expect(result.content).toContain("RRULE:FREQ=DAILY");
  });

  test("auto-detects RRULE syntax when syntax is omitted", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Auto-detect RRULE",
        expression: "DTSTART:20250601T120000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO",
        message: "Auto-detect test",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Syntax: rrule");
    expect(result.content).toContain("RRULE:FREQ=WEEKLY");
  });

  test("rejects RRULE missing DTSTART with deterministic message", async () => {
    const result = await executeScheduleCreate(
      {
        name: "No DTSTART",
        syntax: "rrule",
        expression: "RRULE:FREQ=DAILY",
        message: "Should fail",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("DTSTART");
    expect(result.content).toContain("deterministic");
  });
});

describe("schedule_update with RRULE", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("switches a cron schedule to rrule", async () => {
    await executeScheduleCreate(
      {
        name: "Cron to RRULE",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        syntax: "rrule",
        expression: "DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Schedule updated successfully");
    expect(result.content).toContain("Syntax: rrule");
    expect(result.content).toContain("RRULE:FREQ=DAILY");
  });

  test("auto-detects rrule syntax when updating expression without explicit syntax", async () => {
    await executeScheduleCreate(
      {
        name: "Auto-detect on update",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        expression: "DTSTART:20250601T120000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Syntax: rrule");
    expect(result.content).toContain("RRULE:FREQ=WEEKLY");
  });

  test("auto-detects cron syntax when updating expression without explicit syntax", async () => {
    await executeScheduleCreate(
      {
        name: "Cron auto-detect",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        expression: "30 17 * * 1-5",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Syntax: cron");
  });
});

describe("schedule_list with RRULE", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("shows syntax-aware output for cron schedules", async () => {
    await executeScheduleCreate(
      {
        name: "Cron Job",
        expression: "0 9 * * 1-5",
        message: "Cron test",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("[cron]");
    expect(result.content).toContain("Every weekday at 9:00 AM");
  });

  test("shows syntax-aware output for rrule schedules", async () => {
    await executeScheduleCreate(
      {
        name: "RRULE Job",
        syntax: "rrule",
        expression: "DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY",
        message: "RRULE test",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("[rrule]");
    expect(result.content).toContain("RRULE:FREQ=DAILY");
  });

  test("shows syntax and expression in detail mode", async () => {
    await executeScheduleCreate(
      {
        name: "Detail RRULE",
        syntax: "rrule",
        expression: "DTSTART:20250601T120000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO",
        message: "Detail test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleList({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Syntax: rrule");
    expect(result.content).toContain("Expression:");
    expect(result.content).toContain("RRULE:FREQ=WEEKLY");
  });
});

// ── RRULE set support in schedule tools ──────────────────────────────

describe("schedule_create with RRULE set (EXDATE)", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("creates a schedule with RRULE + EXDATE", async () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY;INTERVAL=1",
      "EXDATE:20250102T090000Z",
    ].join("\n");

    const result = await executeScheduleCreate(
      {
        name: "Daily with exclusion",
        syntax: "rrule",
        expression,
        message: "RRULE set test",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("schedule created successfully");
    expect(result.content).toContain("Syntax: rrule");
  });

  test("creates a schedule with RRULE + RDATE", async () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "RDATE:20250115T090000Z",
    ].join("\n");

    const result = await executeScheduleCreate(
      {
        name: "Weekly with extra date",
        syntax: "rrule",
        expression,
        message: "RDATE test",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("schedule created successfully");
  });

  test("rejects unsupported line types in RRULE set", async () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY",
      "VTIMEZONE:America/New_York",
    ].join("\n");

    const result = await executeScheduleCreate(
      {
        name: "Bad set line",
        syntax: "rrule",
        expression,
        message: "Should fail",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported recurrence line");
    expect(result.content).toContain("Supported line types");
  });

  test("rejects RRULE set missing DTSTART", async () => {
    const expression = ["RRULE:FREQ=DAILY", "EXDATE:20250102T090000Z"].join(
      "\n",
    );

    const result = await executeScheduleCreate(
      {
        name: "Set without DTSTART",
        syntax: "rrule",
        expression,
        message: "Should fail",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("DTSTART");
  });
});

describe("schedule_update with RRULE set", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("updates a cron schedule to RRULE set with EXDATE", async () => {
    await executeScheduleCreate(
      {
        name: "Cron to set",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };

    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY;INTERVAL=1",
      "EXDATE:20250102T090000Z",
    ].join("\n");

    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        syntax: "rrule",
        expression,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Schedule updated successfully");
    expect(result.content).toContain("Syntax: rrule");
  });

  test("rejects update with unsupported set lines", async () => {
    await executeScheduleCreate(
      {
        name: "Bad set update",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };

    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY",
      "VCALENDAR:BEGIN",
    ].join("\n");

    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        syntax: "rrule",
        expression,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported recurrence line");
    expect(result.content).toContain("Supported line types");
  });
});

describe("schedule_list with RRULE set", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("shows [RRULE set] label for schedules with EXDATE", async () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY;INTERVAL=1",
      "EXDATE:20250102T090000Z",
    ].join("\n");

    await executeScheduleCreate(
      {
        name: "Set Schedule",
        syntax: "rrule",
        expression,
        message: "set test",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("[RRULE set]");
  });

  test("does not show [RRULE set] label for simple RRULE", async () => {
    await executeScheduleCreate(
      {
        name: "Simple RRULE",
        syntax: "rrule",
        expression: "DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY",
        message: "simple test",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("[RRULE set]");
  });
});

// ── EXRULE support in schedule tools ──────────────────────────────────

describe("schedule_create with RRULE + EXRULE", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("creates a schedule with RRULE + EXRULE", async () => {
    const expression = [
      "DTSTART:20990101T090000Z",
      "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      "EXRULE:FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    ].join("\n");

    const result = await executeScheduleCreate(
      {
        name: "Weekday-only via EXRULE",
        syntax: "rrule",
        expression,
        message: "EXRULE test",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("schedule created successfully");
    expect(result.content).toContain("Syntax: rrule");
  });

  test("list output shows [RRULE set] label for EXRULE expression", async () => {
    const expression = [
      "DTSTART:20990101T090000Z",
      "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      "EXRULE:FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    ].join("\n");

    await executeScheduleCreate(
      {
        name: "EXRULE Set Schedule",
        syntax: "rrule",
        expression,
        message: "EXRULE set test",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("[RRULE set]");
  });
});

// ── schedule_delete ─────────────────────────────────────────────────

describe("schedule_delete tool", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("deletes a schedule", async () => {
    await executeScheduleCreate(
      {
        name: "Delete Me",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleDelete({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Schedule deleted");
    expect(result.content).toContain("Delete Me");

    // Verify it's actually gone
    const count = getRawDb()
      .query("SELECT COUNT(*) as c FROM cron_jobs")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  test("rejects missing job_id", async () => {
    const result = await executeScheduleDelete({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("job_id is required");
  });

  test("returns error for nonexistent job_id", async () => {
    const result = await executeScheduleDelete({ job_id: "nonexistent" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Schedule not found");
  });
});
