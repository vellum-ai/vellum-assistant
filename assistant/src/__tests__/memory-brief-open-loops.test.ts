import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "brief-open-loops-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  getRootDir: () => testDir,
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
}));

import { createFollowUp } from "../followups/followup-store.js";
import { compileOpenLoopBrief } from "../memory/brief-open-loops.js";
import { initializeDb, resetDb } from "../memory/db.js";
import { getSqlite } from "../memory/db-connection.js";
import { resetTestTables } from "../memory/raw-query.js";
import { createTask } from "../tasks/task-store.js";

initializeDb();

// ── Helpers ──────────────────────────────────────────────────────────

const SCOPE = "test-scope";
const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

/** Get the raw bun:sqlite Database for parameterized inserts. */
function getRawDb(): import("bun:sqlite").Database {
  return getSqlite();
}

function insertOpenLoop(opts: {
  id: string;
  summary: string;
  dueAt?: number | null;
  surfacedAt?: number | null;
  status?: string;
  updatedAt?: number;
  createdAt?: number;
}): void {
  const raw = getRawDb();
  const now = Date.now();
  raw.run(
    `INSERT INTO open_loops (id, scope_id, summary, status, source, due_at, surfaced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'conversation', ?, ?, ?, ?)`,
    [
      opts.id,
      SCOPE,
      opts.summary,
      opts.status ?? "open",
      opts.dueAt ?? null,
      opts.surfacedAt ?? null,
      opts.createdAt ?? now,
      opts.updatedAt ?? now,
    ],
  );
}

function insertWorkItem(opts: {
  id: string;
  taskId: string;
  title: string;
  status?: string;
  priorityTier?: number;
  updatedAt?: number;
}): void {
  const raw = getRawDb();
  const now = Date.now();
  raw.run(
    `INSERT INTO work_items (id, task_id, title, status, priority_tier, sort_index, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      opts.id,
      opts.taskId,
      opts.title,
      opts.status ?? "queued",
      opts.priorityTier ?? 1,
      now,
      opts.updatedAt ?? now,
    ],
  );
}

// ── Teardown ─────────────────────────────────────────────────────────

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => {
  resetTestTables(
    "open_loops",
    "work_items",
    "tasks",
    "task_runs",
    "followups",
  );
});

// ── Tests ────────────────────────────────────────────────────────────

describe("compileOpenLoopBrief", () => {
  test("returns empty when no data exists", () => {
    const result = compileOpenLoopBrief(SCOPE, "msg-1");
    expect(result.bullets).toEqual([]);
    expect(result.resurfacedLoopId).toBeNull();
  });

  // ── Tier ranking ──────────────────────────────────────────────────

  describe("tier ranking", () => {
    test("overdue loops are tier 1", () => {
      const now = Date.now();
      insertOpenLoop({
        id: "ol-overdue",
        summary: "Overdue task",
        dueAt: now - MS_HOUR,
        updatedAt: now - MS_DAY * 10,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-1", now);
      expect(result.bullets).toHaveLength(1);
      expect(result.bullets[0].tier).toBe(1);
      expect(result.bullets[0].summary).toBe("Overdue task");
    });

    test("loops due within 24h are tier 2", () => {
      const now = Date.now();
      insertOpenLoop({
        id: "ol-24h",
        summary: "Due soon",
        dueAt: now + 12 * MS_HOUR,
        updatedAt: now - MS_DAY * 10,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-1", now);
      expect(result.bullets).toHaveLength(1);
      expect(result.bullets[0].tier).toBe(2);
    });

    test("loops due within 7d are tier 3", () => {
      const now = Date.now();
      insertOpenLoop({
        id: "ol-7d",
        summary: "Due this week",
        dueAt: now + 3 * MS_DAY,
        updatedAt: now - MS_DAY * 10,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-1", now);
      expect(result.bullets).toHaveLength(1);
      expect(result.bullets[0].tier).toBe(3);
    });

    test("high-priority work items are tier 4", () => {
      const now = Date.now();
      const task = createTask({ title: "t", template: "t" });
      insertWorkItem({
        id: "wi-high",
        taskId: task.id,
        title: "High priority item",
        priorityTier: 0,
        updatedAt: now - MS_DAY * 10,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-1", now);
      const wiBullet = result.bullets.find((b) => b.source === "work_item");
      expect(wiBullet).toBeDefined();
      expect(wiBullet!.tier).toBe(4);
    });

    test("recently touched loops are tier 5", () => {
      const now = Date.now();
      insertOpenLoop({
        id: "ol-recent",
        summary: "Just updated",
        updatedAt: now - MS_HOUR,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-1", now);
      expect(result.bullets).toHaveLength(1);
      expect(result.bullets[0].tier).toBe(5);
    });

    test("bullets are sorted by tier ascending", () => {
      const now = Date.now();
      insertOpenLoop({
        id: "ol-tier3",
        summary: "Due this week",
        dueAt: now + 3 * MS_DAY,
        updatedAt: now - MS_DAY * 10,
      });
      insertOpenLoop({
        id: "ol-tier1",
        summary: "Overdue",
        dueAt: now - MS_HOUR,
        updatedAt: now - MS_DAY * 10,
      });
      insertOpenLoop({
        id: "ol-tier5",
        summary: "Recent",
        updatedAt: now - MS_HOUR,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-1", now);
      const tiers = result.bullets.map((b) => b.tier);
      expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
      expect(tiers[0]).toBe(1);
    });
  });

  // ── Deduplication ─────────────────────────────────────────────────

  describe("deduplication", () => {
    test("work items with the same summary as an open loop are deduplicated", () => {
      const now = Date.now();
      const task = createTask({ title: "t", template: "t" });

      insertOpenLoop({
        id: "ol-dup",
        summary: "Review PR",
        dueAt: now + MS_HOUR,
        updatedAt: now,
      });
      insertWorkItem({
        id: "wi-dup",
        taskId: task.id,
        title: "Review PR",
        updatedAt: now,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-1", now);
      const summaries = result.bullets.map((b) => b.summary);
      // Should only appear once (from the loop)
      expect(summaries.filter((s) => s === "Review PR")).toHaveLength(1);
      expect(
        result.bullets.find((b) => b.summary === "Review PR")!.source,
      ).toBe("loop");
    });

    test("case-insensitive deduplication", () => {
      const now = Date.now();
      const task = createTask({ title: "t", template: "t" });

      insertOpenLoop({
        id: "ol-case",
        summary: "deploy release",
        dueAt: now + MS_HOUR,
        updatedAt: now,
      });
      insertWorkItem({
        id: "wi-case",
        taskId: task.id,
        title: "Deploy Release",
        updatedAt: now,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-1", now);
      const matching = result.bullets.filter(
        (b) => b.summary.toLowerCase() === "deploy release",
      );
      expect(matching).toHaveLength(1);
    });

    test("unique keys are not deduplicated", () => {
      const now = Date.now();
      const task = createTask({ title: "t", template: "t" });

      insertOpenLoop({
        id: "ol-a",
        summary: "Fix bug",
        dueAt: now + MS_HOUR,
        updatedAt: now,
      });
      insertWorkItem({
        id: "wi-b",
        taskId: task.id,
        title: "Write tests",
        updatedAt: now,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-1", now);
      expect(result.bullets).toHaveLength(2);
    });
  });

  // ── Follow-up integration ────────────────────────────────────────

  describe("follow-ups", () => {
    test("overdue follow-ups appear as tier 1", () => {
      const now = Date.now();
      createFollowUp({
        channel: "email",
        conversationId: "conv-1",
        expectedResponseBy: now - MS_HOUR,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-1", now);
      const fuBullet = result.bullets.find((b) => b.source === "followup");
      expect(fuBullet).toBeDefined();
      expect(fuBullet!.tier).toBe(1);
    });

    test("pending follow-ups due within 24h are tier 2", () => {
      const now = Date.now();
      createFollowUp({
        channel: "slack",
        conversationId: "conv-2",
        expectedResponseBy: now + 12 * MS_HOUR,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-1", now);
      const fuBullet = result.bullets.find((b) => b.source === "followup");
      expect(fuBullet).toBeDefined();
      expect(fuBullet!.tier).toBe(2);
    });
  });

  // ── Deterministic resurfacing ────────────────────────────────────

  describe("deterministic resurfacing", () => {
    test("resurfaces one low-salience loop from open_loops", () => {
      const now = Date.now();
      // Create loops that are old and have no due date → tier 6 (low salience)
      insertOpenLoop({
        id: "ol-old-1",
        summary: "Old loop 1",
        updatedAt: now - MS_DAY * 30,
        createdAt: now - MS_DAY * 30,
      });
      insertOpenLoop({
        id: "ol-old-2",
        summary: "Old loop 2",
        updatedAt: now - MS_DAY * 30,
        createdAt: now - MS_DAY * 30,
      });
      insertOpenLoop({
        id: "ol-old-3",
        summary: "Old loop 3",
        updatedAt: now - MS_DAY * 30,
        createdAt: now - MS_DAY * 30,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-resurface", now);

      // Exactly one should be resurfaced
      expect(result.resurfacedLoopId).not.toBeNull();
      expect(result.bullets).toHaveLength(1);
      expect(result.bullets[0].tier).toBe(5);
    });

    test("resurfacing is deterministic for the same seed", () => {
      const now = Date.now();
      for (let i = 1; i <= 5; i++) {
        insertOpenLoop({
          id: `ol-det-${i}`,
          summary: `Deterministic loop ${i}`,
          updatedAt: now - MS_DAY * 30,
          createdAt: now - MS_DAY * 30,
        });
      }

      const r1 = compileOpenLoopBrief(SCOPE, "msg-det", now);

      // Reset surfacedAt and updatedAt so the second call has same candidates
      // (updateLastSurfacedAt also writes updatedAt, which would change tier)
      const oldUpdatedAt = now - MS_DAY * 30;
      getRawDb().run(
        `UPDATE open_loops SET surfaced_at = NULL, updated_at = ?`,
        [oldUpdatedAt],
      );

      const r2 = compileOpenLoopBrief(SCOPE, "msg-det", now);

      expect(r1.resurfacedLoopId).toBe(r2.resurfacedLoopId);
    });

    test("different userMessageId produces different selection", () => {
      const now = Date.now();
      // Need enough loops that different seeds are likely to pick different ones
      for (let i = 1; i <= 20; i++) {
        insertOpenLoop({
          id: `ol-vary-${i}`,
          summary: `Varying loop ${i}`,
          updatedAt: now - MS_DAY * 30,
          createdAt: now - MS_DAY * 30,
        });
      }

      const selections = new Set<string | null>();
      const oldUpdatedAt = now - MS_DAY * 30;
      for (let i = 0; i < 10; i++) {
        // Reset surfacedAt and updatedAt between calls so all loops stay low-salience
        getRawDb().run(
          `UPDATE open_loops SET surfaced_at = NULL, updated_at = ?`,
          [oldUpdatedAt],
        );
        const r = compileOpenLoopBrief(SCOPE, `msg-vary-${i}`, now);
        selections.add(r.resurfacedLoopId);
      }

      // With 20 candidates and 10 different seeds, we should see at least 2
      // different selections (overwhelmingly likely)
      expect(selections.size).toBeGreaterThanOrEqual(2);
    });

    test("updates surfacedAt on the resurfaced loop", () => {
      const now = Date.now();
      insertOpenLoop({
        id: "ol-surf",
        summary: "Will be surfaced",
        updatedAt: now - MS_DAY * 30,
        createdAt: now - MS_DAY * 30,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-surf", now);
      expect(result.resurfacedLoopId).toBe("ol-surf");

      // Verify surfacedAt was written
      const surfaced = getRawDb()
        .query(`SELECT surfaced_at FROM open_loops WHERE id = 'ol-surf'`)
        .get() as { surfaced_at: number } | null;
      expect(surfaced).not.toBeNull();
      expect(surfaced!.surfaced_at).toBe(now);
    });

    test("low-salience work items are not resurfaced", () => {
      const now = Date.now();
      const task = createTask({ title: "t", template: "t" });

      // Only work items, no loops — should not resurface
      insertWorkItem({
        id: "wi-old",
        taskId: task.id,
        title: "Old work item",
        updatedAt: now - MS_DAY * 30,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-no-resurface", now);
      expect(result.resurfacedLoopId).toBeNull();
      // Work item is tier 6, so it should not appear in ranked output
      expect(result.bullets).toHaveLength(0);
    });
  });

  // ── Scope isolation ──────────────────────────────────────────────

  describe("scope isolation", () => {
    test("only includes loops from the specified scope", () => {
      const now = Date.now();
      insertOpenLoop({
        id: "ol-scope-a",
        summary: "In scope",
        dueAt: now + MS_HOUR,
        updatedAt: now,
      });

      // Insert loop for a different scope directly
      getRawDb().run(
        `INSERT INTO open_loops (id, scope_id, summary, status, source, due_at, created_at, updated_at)
         VALUES ('ol-scope-b', 'other-scope', 'Out of scope', 'open', 'conversation', ?, ?, ?)`,
        [now + MS_HOUR, now, now],
      );

      const result = compileOpenLoopBrief(SCOPE, "msg-scope", now);
      expect(result.bullets).toHaveLength(1);
      expect(result.bullets[0].summary).toBe("In scope");
    });
  });

  // ── Mixed sources ────────────────────────────────────────────────

  describe("mixed sources", () => {
    test("merges loops, work items, and follow-ups without duplicates", () => {
      const now = Date.now();
      const task = createTask({ title: "t", template: "t" });

      insertOpenLoop({
        id: "ol-mix",
        summary: "Loop item",
        dueAt: now - MS_HOUR,
        updatedAt: now,
      });
      insertWorkItem({
        id: "wi-mix",
        taskId: task.id,
        title: "Work item",
        priorityTier: 0,
        updatedAt: now,
      });
      createFollowUp({
        channel: "email",
        conversationId: "conv-mix",
        expectedResponseBy: now + 6 * MS_HOUR,
      });

      const result = compileOpenLoopBrief(SCOPE, "msg-mix", now);
      expect(result.bullets).toHaveLength(3);

      const sources = result.bullets.map((b) => b.source);
      expect(sources).toContain("loop");
      expect(sources).toContain("work_item");
      expect(sources).toContain("followup");

      // All keys are unique
      const keys = result.bullets.map((b) => b.key);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });
});
