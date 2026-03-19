import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "brief-time-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
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
  truncateForLog: (value: string) => value,
}));

import { compileTimeBrief } from "../memory/brief-time.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { createSchedule } from "../schedule/schedule-store.js";

initializeDb();

const SCOPE_ID = "default";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function getRawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

function insertTimeContext(opts: {
  id: string;
  summary: string;
  source?: string;
  activeFrom: number;
  activeUntil: number;
  scopeId?: string;
}): void {
  const now = Date.now();
  getRawDb().run(
    `INSERT INTO time_contexts (id, scope_id, summary, source, active_from, active_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.scopeId ?? SCOPE_ID,
      opts.summary,
      opts.source ?? "conversation",
      opts.activeFrom,
      opts.activeUntil,
      now,
      now,
    ],
  );
}

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => {
  getRawDb().run("DELETE FROM time_contexts");
  getRawDb().run("DELETE FROM cron_runs");
  getRawDb().run("DELETE FROM cron_jobs");
});

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe("compileTimeBrief", () => {
  test("returns null when nothing qualifies", () => {
    const now = Date.now();
    const result = compileTimeBrief(getDb(), SCOPE_ID, now);
    expect(result).toBeNull();
  });

  test("surfaces a tomorrow-morning event from time_contexts", () => {
    const now = Date.now();
    // Active window that starts before now and ends tomorrow
    insertTimeContext({
      id: "tc-morning",
      summary: "Team standup tomorrow at 9am",
      activeFrom: now - HOUR,
      activeUntil: now + DAY,
    });

    const result = compileTimeBrief(getDb(), SCOPE_ID, now);
    expect(result).not.toBeNull();
    expect(result).toContain("### Time-Relevant Context");
    expect(result).toContain("Team standup tomorrow at 9am");
  });

  test("surfaces a temporary situation (currently happening)", () => {
    const now = Date.now();
    // Active for the next 2 hours
    insertTimeContext({
      id: "tc-situation",
      summary: "User is in a meeting until 3pm",
      activeFrom: now - 30 * 60 * 1000,
      activeUntil: now + 2 * HOUR,
    });

    const result = compileTimeBrief(getDb(), SCOPE_ID, now);
    expect(result).not.toBeNull();
    expect(result).toContain("User is in a meeting until 3pm");
  });

  test("expired time_contexts are not surfaced", () => {
    const now = Date.now();
    // Expired yesterday
    insertTimeContext({
      id: "tc-expired",
      summary: "Dentist appointment yesterday",
      activeFrom: now - 2 * DAY,
      activeUntil: now - DAY,
    });

    const result = compileTimeBrief(getDb(), SCOPE_ID, now);
    expect(result).toBeNull();
  });

  test("future time_contexts not yet active are not surfaced", () => {
    const now = Date.now();
    // Starts tomorrow
    insertTimeContext({
      id: "tc-future",
      summary: "Vacation starts next week",
      activeFrom: now + DAY,
      activeUntil: now + 8 * DAY,
    });

    const result = compileTimeBrief(getDb(), SCOPE_ID, now);
    expect(result).toBeNull();
  });

  test("includes due-soon schedule jobs", () => {
    const now = Date.now();
    // Create a one-shot schedule due in 2 hours
    createSchedule({
      name: "Send weekly report",
      message: "Time to send the weekly report",
      nextRunAt: now + 2 * HOUR,
    });

    const result = compileTimeBrief(getDb(), SCOPE_ID, now);
    expect(result).not.toBeNull();
    expect(result).toContain("### Time-Relevant Context");
    expect(result).toContain('Scheduled: "Send weekly report"');
    expect(result).toContain("in 2 hours");
  });

  test("sorts by urgency: happening now > overdue > within 24h > within 7d", () => {
    const now = Date.now();

    // Within 7 days (lower priority)
    insertTimeContext({
      id: "tc-week",
      summary: "Quarterly review ends Friday",
      activeFrom: now - DAY,
      activeUntil: now + 5 * DAY,
    });

    // Happening now (expiring in 6 hours — highest priority)
    insertTimeContext({
      id: "tc-now",
      summary: "User traveling today",
      activeFrom: now - 2 * HOUR,
      activeUntil: now + 6 * HOUR,
    });

    // Within 24h (ending tomorrow — medium priority)
    insertTimeContext({
      id: "tc-24h",
      summary: "Project deadline tomorrow morning",
      activeFrom: now - DAY,
      activeUntil: now + 20 * HOUR,
    });

    const result = compileTimeBrief(getDb(), SCOPE_ID, now);
    expect(result).not.toBeNull();

    const lines = result!.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(3);
    // Happening now (remaining <= 24h) comes first
    expect(lines[0]).toContain("User traveling today");
    // Within 24h comes second
    expect(lines[1]).toContain("Project deadline tomorrow morning");
    // Within 7d comes last
    expect(lines[2]).toContain("Quarterly review ends Friday");
  });

  test("caps at 3 entries", () => {
    const now = Date.now();

    insertTimeContext({
      id: "tc-1",
      summary: "Context one",
      activeFrom: now - HOUR,
      activeUntil: now + 2 * HOUR,
    });
    insertTimeContext({
      id: "tc-2",
      summary: "Context two",
      activeFrom: now - HOUR,
      activeUntil: now + 3 * HOUR,
    });
    insertTimeContext({
      id: "tc-3",
      summary: "Context three",
      activeFrom: now - HOUR,
      activeUntil: now + 4 * HOUR,
    });
    insertTimeContext({
      id: "tc-4",
      summary: "Context four (should be dropped)",
      activeFrom: now - HOUR,
      activeUntil: now + 5 * HOUR,
    });

    const result = compileTimeBrief(getDb(), SCOPE_ID, now);
    expect(result).not.toBeNull();

    const lines = result!.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(3);
    expect(result).not.toContain("Context four");
  });

  test("filters by scopeId — ignores other scopes", () => {
    const now = Date.now();
    insertTimeContext({
      id: "tc-other",
      summary: "Other scope context",
      activeFrom: now - HOUR,
      activeUntil: now + DAY,
      scopeId: "other-scope",
    });

    const result = compileTimeBrief(getDb(), SCOPE_ID, now);
    expect(result).toBeNull();
  });

  test("mixes time_contexts and schedules in deterministic order", () => {
    const now = Date.now();

    // A schedule due in 30 minutes (within 24h bucket)
    createSchedule({
      name: "Daily standup reminder",
      message: "Standup time",
      nextRunAt: now + 30 * 60 * 1000,
    });

    // A time context happening now (remaining 3 hours)
    insertTimeContext({
      id: "tc-active",
      summary: "Focus time until noon",
      activeFrom: now - HOUR,
      activeUntil: now + 3 * HOUR,
    });

    const result = compileTimeBrief(getDb(), SCOPE_ID, now);
    expect(result).not.toBeNull();

    const lines = result!.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(2);
    // Both happening-now time context and within-24h schedule should appear
    expect(result).toContain("Focus time until noon");
    expect(result).toContain("Daily standup reminder");
  });
});
