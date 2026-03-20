import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "brief-wrapper-test-"));

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
  truncateForLog: (value: string) => value,
}));

import {
  stripInjectedContext,
  stripUserTextBlocksByPrefix,
} from "../daemon/conversation-runtime-assembly.js";
import { compileMemoryBrief } from "../memory/brief.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { getSqlite } from "../memory/db-connection.js";
import { resetTestTables } from "../memory/raw-query.js";
import type { Message } from "../providers/types.js";

initializeDb();

// ── Constants ──────────────────────────────────────────────────────────

const SCOPE_ID = "default";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ── Helpers ────────────────────────────────────────────────────────────

function getRawDb(): import("bun:sqlite").Database {
  return getSqlite();
}

function insertTimeContext(opts: {
  id: string;
  summary: string;
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
      "conversation",
      opts.activeFrom,
      opts.activeUntil,
      now,
      now,
    ],
  );
}

function insertOpenLoop(opts: {
  id: string;
  summary: string;
  dueAt?: number | null;
  updatedAt?: number;
}): void {
  const now = Date.now();
  getRawDb().run(
    `INSERT INTO open_loops (id, scope_id, summary, status, source, due_at, surfaced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'conversation', ?, ?, ?, ?)`,
    [
      opts.id,
      SCOPE_ID,
      opts.summary,
      "open",
      opts.dueAt ?? null,
      null,
      now,
      opts.updatedAt ?? now,
    ],
  );
}

// ── Teardown ───────────────────────────────────────────────────────────

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
    "time_contexts",
    "open_loops",
    "work_items",
    "tasks",
    "task_runs",
    "followups",
    "cron_runs",
    "cron_jobs",
  );
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("compileMemoryBrief", () => {
  test("returns empty string when neither section has content", () => {
    const now = Date.now();
    const result = compileMemoryBrief(getDb(), SCOPE_ID, "msg-1", now);
    expect(result.text).toBe("");
    expect(result.resurfacedLoopId).toBeNull();
  });

  test("renders only the time section when open loops are empty", () => {
    const now = Date.now();
    insertTimeContext({
      id: "tc-1",
      summary: "Meeting with Alice in 2 hours",
      activeFrom: now - HOUR,
      activeUntil: now + 2 * HOUR,
    });

    const result = compileMemoryBrief(getDb(), SCOPE_ID, "msg-1", now);

    expect(result.text).toContain("<memory_brief>");
    expect(result.text).toContain("</memory_brief>");
    expect(result.text).toContain("### Time-Relevant Context");
    expect(result.text).toContain("Meeting with Alice in 2 hours");
    // Should NOT contain Open Loops section
    expect(result.text).not.toContain("### Open Loops");
  });

  test("renders only the open loops section when time context is empty", () => {
    const now = Date.now();
    insertOpenLoop({
      id: "ol-1",
      summary: "Fix the login bug",
      dueAt: now + 12 * HOUR,
      updatedAt: now - DAY * 10,
    });

    const result = compileMemoryBrief(getDb(), SCOPE_ID, "msg-1", now);

    expect(result.text).toContain("<memory_brief>");
    expect(result.text).toContain("</memory_brief>");
    expect(result.text).toContain("### Open Loops");
    expect(result.text).toContain("Fix the login bug");
    // Should NOT contain Time-Relevant Context section
    expect(result.text).not.toContain("### Time-Relevant Context");
  });

  test("renders both sections when both have content", () => {
    const now = Date.now();

    insertTimeContext({
      id: "tc-1",
      summary: "Quarterly review deadline tomorrow",
      activeFrom: now - HOUR,
      activeUntil: now + DAY,
    });

    insertOpenLoop({
      id: "ol-1",
      summary: "Reply to vendor email",
      dueAt: now + 6 * HOUR,
      updatedAt: now - DAY * 10,
    });

    const result = compileMemoryBrief(getDb(), SCOPE_ID, "msg-1", now);

    expect(result.text).toContain("<memory_brief>");
    expect(result.text).toContain("</memory_brief>");
    expect(result.text).toContain("### Time-Relevant Context");
    expect(result.text).toContain("Quarterly review deadline tomorrow");
    expect(result.text).toContain("### Open Loops");
    expect(result.text).toContain("Reply to vendor email");

    // Sections should be separated by a blank line
    expect(result.text).toContain(
      "### Time-Relevant Context\n- Quarterly review deadline tomorrow\n\n### Open Loops",
    );
  });

  test("wraps content in <memory_brief> tags", () => {
    const now = Date.now();
    insertTimeContext({
      id: "tc-1",
      summary: "Something happening",
      activeFrom: now - HOUR,
      activeUntil: now + HOUR,
    });

    const result = compileMemoryBrief(getDb(), SCOPE_ID, "msg-1", now);

    expect(result.text.startsWith("<memory_brief>\n")).toBe(true);
    expect(result.text.endsWith("\n</memory_brief>")).toBe(true);
  });

  test("forwards resurfacedLoopId from open-loop compiler", () => {
    const now = Date.now();
    // Insert a low-salience loop (no dueAt, updated long ago) to trigger resurfacing
    insertOpenLoop({
      id: "ol-stale",
      summary: "Old forgotten task",
      updatedAt: now - DAY * 30,
    });

    const result = compileMemoryBrief(getDb(), SCOPE_ID, "msg-1", now);
    // The stale loop should be resurfaced
    expect(result.resurfacedLoopId).toBe("ol-stale");
  });
});

// ── Strip tests ────────────────────────────────────────────────────────

describe("memory_brief strip support", () => {
  test("stripInjectedContext removes <memory_brief> blocks", () => {
    const briefText = `<memory_brief>\n### Time-Relevant Context\n- Meeting in 2 hours\n</memory_brief>`;
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: briefText },
          { type: "text", text: "What's on my calendar?" },
        ],
      },
    ];

    const stripped = stripInjectedContext(messages);
    expect(stripped).toHaveLength(1);
    expect(stripped[0].content).toHaveLength(1);
    expect(stripped[0].content[0]).toEqual({
      type: "text",
      text: "What's on my calendar?",
    });
  });

  test("stripUserTextBlocksByPrefix removes <memory_brief> by prefix", () => {
    const briefText = `<memory_brief>\n### Open Loops\n- Fix the bug\n</memory_brief>`;
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: briefText },
          { type: "text", text: "Hello" },
        ],
      },
    ];

    const stripped = stripUserTextBlocksByPrefix(messages, ["<memory_brief>"]);
    expect(stripped).toHaveLength(1);
    expect(stripped[0].content).toHaveLength(1);
    expect(stripped[0].content[0]).toEqual({ type: "text", text: "Hello" });
  });

  test("drops entire message when only a <memory_brief> block remains", () => {
    const briefText = `<memory_brief>\n### Time-Relevant Context\n- Deadline today\n</memory_brief>`;
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: briefText }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Got it." }],
      },
    ];

    const stripped = stripInjectedContext(messages);
    // The user message with only the brief block should be dropped entirely
    expect(stripped).toHaveLength(1);
    expect(stripped[0].role).toBe("assistant");
  });

  test("preserves user-authored text that does not start with <memory_brief>", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "I was thinking about <memory_brief> tags" },
        ],
      },
    ];

    const stripped = stripInjectedContext(messages);
    expect(stripped).toHaveLength(1);
    expect(stripped[0].content[0]).toEqual({
      type: "text",
      text: "I was thinking about <memory_brief> tags",
    });
  });
});
