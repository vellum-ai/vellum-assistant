import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "followup-tools-test-"));

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
import { executeFollowupCreate } from "../tools/followups/followup_create.js";
import { executeFollowupList } from "../tools/followups/followup_list.js";
import { executeFollowupResolve } from "../tools/followups/followup_resolve.js";
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

function clearFollowups(): void {
  getRawDb().run("DELETE FROM followups");
}

function extractFollowupId(content: string): string {
  const match = content.match(/Follow-up (\S+)/);
  expect(match).not.toBeNull();
  return match![1];
}

// ── followup_create ─────────────────────────────────────────────────

describe("followup_create tool", () => {
  beforeEach(clearFollowups);

  test("creates a follow-up with required fields", async () => {
    const result = await executeFollowupCreate(
      {
        channel: "email",
        thread_id: "thread-123",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Created follow-up");
    expect(result.content).toContain("email");
    expect(result.content).toContain("thread-123");
    expect(result.content).toContain("Status: pending");
  });

  test("creates a follow-up with expected response deadline", async () => {
    const result = await executeFollowupCreate(
      {
        channel: "slack",
        thread_id: "slack-thread-1",
        expected_response_hours: 24,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Expected response by");
  });

  test("creates a follow-up with reminder_schedule_id (canonical)", async () => {
    const result = await executeFollowupCreate(
      {
        channel: "email",
        thread_id: "thread-456",
        reminder_schedule_id: "sched-abc",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Reminder schedule: sched-abc");
  });

  test("rejects missing channel", async () => {
    const result = await executeFollowupCreate(
      {
        thread_id: "thread-123",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("channel is required");
  });

  test("rejects empty channel", async () => {
    const result = await executeFollowupCreate(
      {
        channel: "   ",
        thread_id: "thread-123",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("channel is required");
  });

  test("rejects missing thread_id", async () => {
    const result = await executeFollowupCreate(
      {
        channel: "email",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("thread_id is required");
  });

  test("rejects non-positive expected_response_hours", async () => {
    const result = await executeFollowupCreate(
      {
        channel: "email",
        thread_id: "thread-123",
        expected_response_hours: -1,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "expected_response_hours must be a positive number",
    );
  });

  test("rejects nonexistent contact_id", async () => {
    const result = await executeFollowupCreate(
      {
        channel: "email",
        thread_id: "thread-123",
        contact_id: "nonexistent-contact",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Contact "nonexistent-contact" not found');
  });
});

// ── followup_list ───────────────────────────────────────────────────

describe("followup_list tool", () => {
  beforeEach(clearFollowups);

  test("returns empty message when no follow-ups exist", async () => {
    const result = await executeFollowupList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("No follow-ups found");
  });

  test("lists all follow-ups", async () => {
    await executeFollowupCreate(
      { channel: "email", thread_id: "thread-1" },
      ctx,
    );
    await executeFollowupCreate(
      { channel: "slack", thread_id: "thread-2" },
      ctx,
    );

    const result = await executeFollowupList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Found 2 follow-up(s)");
    expect(result.content).toContain("email");
    expect(result.content).toContain("slack");
  });

  test("filters by status", async () => {
    await executeFollowupCreate(
      { channel: "email", thread_id: "thread-1" },
      ctx,
    );

    const result = await executeFollowupList({ status: "pending" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Found 1 follow-up(s)");
  });

  test("filters by channel", async () => {
    await executeFollowupCreate(
      { channel: "email", thread_id: "thread-1" },
      ctx,
    );
    await executeFollowupCreate(
      { channel: "slack", thread_id: "thread-2" },
      ctx,
    );

    const result = await executeFollowupList({ channel: "email" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("email");
    expect(result.content).not.toContain("**slack**");
  });

  test("returns error for invalid status", async () => {
    const result = await executeFollowupList({ status: "invalid" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid status");
  });
});

// ── followup_resolve ────────────────────────────────────────────────

describe("followup_resolve tool", () => {
  beforeEach(clearFollowups);

  test("resolves a follow-up by ID", async () => {
    const createResult = await executeFollowupCreate(
      {
        channel: "email",
        thread_id: "thread-1",
      },
      ctx,
    );
    const id = extractFollowupId(createResult.content);

    const result = await executeFollowupResolve({ id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Resolved follow-up");
    expect(result.content).toContain("Status: resolved");
  });

  test("resolves by channel and thread_id", async () => {
    await executeFollowupCreate(
      {
        channel: "email",
        thread_id: "thread-1",
      },
      ctx,
    );

    const result = await executeFollowupResolve(
      {
        channel: "email",
        thread_id: "thread-1",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Resolved 1 follow-up(s)");
  });

  test("resolves multiple follow-ups by thread", async () => {
    await executeFollowupCreate(
      { channel: "email", thread_id: "shared-thread" },
      ctx,
    );
    await executeFollowupCreate(
      { channel: "email", thread_id: "shared-thread" },
      ctx,
    );

    const result = await executeFollowupResolve(
      {
        channel: "email",
        thread_id: "shared-thread",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Resolved 2 follow-up(s)");
  });

  test("returns no-match message for nonexistent thread", async () => {
    const result = await executeFollowupResolve(
      {
        channel: "email",
        thread_id: "nonexistent",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("No pending follow-up found");
  });

  test("returns error when resolving nonexistent ID", async () => {
    const result = await executeFollowupResolve({ id: "bad-id" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  test("rejects when neither id nor channel+thread_id provided", async () => {
    const result = await executeFollowupResolve({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Either id or both channel and thread_id are required",
    );
  });
});
