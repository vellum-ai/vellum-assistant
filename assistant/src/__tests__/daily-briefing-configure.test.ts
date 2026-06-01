import { beforeEach, describe, expect, mock, test } from "bun:test";

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
    daemon: { timezone: "America/New_York" },
  }),
}));

import type { Database } from "bun:sqlite";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { dailyBriefingConfigureTool } from "../tools/briefing/configure.js";
import { BRIEFING_SCHEDULE_NAME } from "../tools/briefing/prompt.js";
import type { ToolContext } from "../tools/types.js";

initializeDb();

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

const guardianCtx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conversation",
  trustClass: "guardian",
};

const untrustedCtx: ToolContext = {
  ...guardianCtx,
  trustClass: "trusted_contact",
};

beforeEach(() => {
  getRawDb().run("DELETE FROM cron_runs");
  getRawDb().run("DELETE FROM cron_jobs");
});

// ── guardian guard ───────────────────────────────────────────────────

describe("trust guard", () => {
  test("rejects non-guardian callers", async () => {
    const result = await dailyBriefingConfigureTool.execute(
      { action: "enable" },
      untrustedCtx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("guardian");
  });
});

// ── status ───────────────────────────────────────────────────────────

describe("action=status", () => {
  test("reports no briefing configured when table is empty", async () => {
    const result = await dailyBriefingConfigureTool.execute(
      { action: "status" },
      guardianCtx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No daily briefing");
  });

  test("reports schedule state after creation", async () => {
    await dailyBriefingConfigureTool.execute({ action: "enable" }, guardianCtx);
    const result = await dailyBriefingConfigureTool.execute(
      { action: "status" },
      guardianCtx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("enabled");
    expect(result.content).toContain("0 9 * * *");
  });
});

// ── enable ───────────────────────────────────────────────────────────

describe("action=enable", () => {
  test("creates a new schedule on first enable", async () => {
    const result = await dailyBriefingConfigureTool.execute(
      { action: "enable" },
      guardianCtx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("created and enabled");
    expect(result.content).toContain("09:00");
  });

  test("uses custom time when provided", async () => {
    const result = await dailyBriefingConfigureTool.execute(
      { action: "enable", time: "07:30" },
      guardianCtx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("07:30");
  });

  test("uses custom timezone when provided", async () => {
    const result = await dailyBriefingConfigureTool.execute(
      { action: "enable", timezone: "Europe/London" },
      guardianCtx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Europe/London");
  });

  test("re-enables a disabled schedule without creating a duplicate", async () => {
    await dailyBriefingConfigureTool.execute({ action: "enable" }, guardianCtx);
    await dailyBriefingConfigureTool.execute(
      { action: "disable" },
      guardianCtx,
    );
    const result = await dailyBriefingConfigureTool.execute(
      { action: "enable" },
      guardianCtx,
    );
    expect(result.isError).toBe(false);
    // Should update, not create ("enabled" not "created")
    expect(result.content).toContain("enabled");

    // Exactly one schedule should exist
    const rows = getRawDb()
      .query(`SELECT COUNT(*) as c FROM cron_jobs WHERE name = ?`)
      .get(BRIEFING_SCHEDULE_NAME) as { c: number };
    expect(rows.c).toBe(1);
  });

  test("schedule is stored with correct name and mode", async () => {
    await dailyBriefingConfigureTool.execute({ action: "enable" }, guardianCtx);
    const row = getRawDb()
      .query(`SELECT * FROM cron_jobs WHERE name = ?`)
      .get(BRIEFING_SCHEDULE_NAME) as Record<string, unknown> | null;
    expect(row).not.toBeNull();
    expect(row!.mode).toBe("execute");
    expect(row!.enabled).toBe(1);
    expect(row!.reuse_conversation).toBe(1);
  });
});

// ── disable ──────────────────────────────────────────────────────────

describe("action=disable", () => {
  test("disables an enabled schedule", async () => {
    await dailyBriefingConfigureTool.execute({ action: "enable" }, guardianCtx);
    const result = await dailyBriefingConfigureTool.execute(
      { action: "disable" },
      guardianCtx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("disabled");

    const row = getRawDb()
      .query(`SELECT enabled FROM cron_jobs WHERE name = ?`)
      .get(BRIEFING_SCHEDULE_NAME) as { enabled: number } | null;
    expect(row!.enabled).toBe(0);
  });

  test("is a no-op when no schedule exists", async () => {
    const result = await dailyBriefingConfigureTool.execute(
      { action: "disable" },
      guardianCtx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("nothing to disable");
  });

  test("is a no-op when already disabled", async () => {
    await dailyBriefingConfigureTool.execute({ action: "enable" }, guardianCtx);
    await dailyBriefingConfigureTool.execute(
      { action: "disable" },
      guardianCtx,
    );
    const result = await dailyBriefingConfigureTool.execute(
      { action: "disable" },
      guardianCtx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("already disabled");
  });
});

// ── set_time ─────────────────────────────────────────────────────────

describe("action=set_time", () => {
  test("updates delivery time on existing schedule", async () => {
    await dailyBriefingConfigureTool.execute({ action: "enable" }, guardianCtx);
    const result = await dailyBriefingConfigureTool.execute(
      { action: "set_time", time: "08:00" },
      guardianCtx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("08:00");

    const row = getRawDb()
      .query(`SELECT cron_expression FROM cron_jobs WHERE name = ?`)
      .get(BRIEFING_SCHEDULE_NAME) as { cron_expression: string } | null;
    expect(row!.cron_expression).toBe("0 8 * * *");
  });

  test("rejects missing time field", async () => {
    await dailyBriefingConfigureTool.execute({ action: "enable" }, guardianCtx);
    const result = await dailyBriefingConfigureTool.execute(
      { action: "set_time" },
      guardianCtx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("time is required");
  });

  test("rejects malformed time string", async () => {
    await dailyBriefingConfigureTool.execute({ action: "enable" }, guardianCtx);
    const result = await dailyBriefingConfigureTool.execute(
      { action: "set_time", time: "9am" },
      guardianCtx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid time");
  });

  test("rejects out-of-range hour", async () => {
    await dailyBriefingConfigureTool.execute({ action: "enable" }, guardianCtx);
    const result = await dailyBriefingConfigureTool.execute(
      { action: "set_time", time: "25:00" },
      guardianCtx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid time");
  });

  test("errors when no schedule exists yet", async () => {
    const result = await dailyBriefingConfigureTool.execute(
      { action: "set_time", time: "08:00" },
      guardianCtx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("enable");
  });
});
