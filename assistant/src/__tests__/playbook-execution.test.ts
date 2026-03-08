import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "playbook-exec-test-"));

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

mock.module("../memory/jobs-store.js", () => ({
  enqueueMemoryJob: () => {},
}));

import type { Database } from "bun:sqlite";

import { v4 as uuid } from "uuid";

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { computeMemoryFingerprint } from "../memory/fingerprint.js";
import { memoryItems } from "../memory/schema.js";
import { compilePlaybooks } from "../playbooks/playbook-compiler.js";
import { parsePlaybookStatement } from "../playbooks/types.js";
import { executePlaybookCreate } from "../skills/bundled-skills/playbooks/tools/playbook-create.js";
import { executePlaybookDelete } from "../skills/bundled-skills/playbooks/tools/playbook-delete.js";
import { executePlaybookList } from "../skills/bundled-skills/playbooks/tools/playbook-list.js";
import { executePlaybookUpdate } from "../skills/bundled-skills/playbooks/tools/playbook-update.js";
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

function clearPlaybooks(): void {
  getRawDb().run("DELETE FROM memory_items WHERE kind = 'playbook'");
}

const ctx: ToolContext = {
  workingDir: "/tmp",
  sessionId: "test-session",
  conversationId: "test-conversation",
  trustClass: "guardian",
};

function insertPlaybookRow(
  overrides: Partial<{
    id: string;
    trigger: string;
    action: string;
    channel: string;
    category: string;
    autonomyLevel: string;
    priority: number;
    status: string;
    importance: number;
    scopeId: string;
    invalidAt: number | null;
    statement: string;
  }> = {},
): string {
  const db = getDb();
  const id = overrides.id ?? uuid();
  const trigger = overrides.trigger ?? "test trigger";
  const action = overrides.action ?? "test action";
  const channel = overrides.channel ?? "*";
  const category = overrides.category ?? "general";
  const autonomyLevel = overrides.autonomyLevel ?? "draft";
  const priority = overrides.priority ?? 0;
  const status = overrides.status ?? "active";
  const importance = overrides.importance ?? 0.8;
  const scopeId = overrides.scopeId ?? "default";
  const invalidAt = overrides.invalidAt ?? null;

  const statement =
    overrides.statement ??
    JSON.stringify({
      trigger,
      action,
      channel,
      category,
      autonomyLevel,
      priority,
    });
  const subject = `Playbook: ${trigger}`;
  const fingerprint = computeMemoryFingerprint(
    scopeId,
    "playbook",
    subject,
    statement,
  );
  const now = Date.now();

  db.insert(memoryItems)
    .values({
      id,
      kind: "playbook",
      subject,
      statement,
      status,
      confidence: 0.95,
      importance,
      fingerprint,
      verificationState: "user_confirmed",
      scopeId,
      firstSeenAt: now,
      lastSeenAt: now,
      lastUsedAt: null,
      invalidAt,
    })
    .run();

  return id;
}

// ── parsePlaybookStatement ──────────────────────────────────────────

describe("parsePlaybookStatement", () => {
  test("parses valid playbook JSON with all fields", () => {
    const statement = JSON.stringify({
      trigger: "meeting request",
      action: "check calendar",
      channel: "email",
      category: "scheduling",
      autonomyLevel: "auto",
      priority: 10,
    });

    const result = parsePlaybookStatement(statement);

    expect(result).not.toBeNull();
    expect(result!.trigger).toBe("meeting request");
    expect(result!.action).toBe("check calendar");
    expect(result!.channel).toBe("email");
    expect(result!.category).toBe("scheduling");
    expect(result!.autonomyLevel).toBe("auto");
    expect(result!.priority).toBe(10);
  });

  test("applies defaults for missing optional fields", () => {
    const statement = JSON.stringify({
      trigger: "newsletter",
      action: "archive it",
    });

    const result = parsePlaybookStatement(statement);

    expect(result).not.toBeNull();
    expect(result!.trigger).toBe("newsletter");
    expect(result!.action).toBe("archive it");
    expect(result!.channel).toBe("*");
    expect(result!.category).toBe("general");
    expect(result!.autonomyLevel).toBe("draft");
    expect(result!.priority).toBe(0);
  });

  test("returns null for invalid JSON", () => {
    expect(parsePlaybookStatement("not json")).toBeNull();
    expect(parsePlaybookStatement("{broken")).toBeNull();
    expect(parsePlaybookStatement("")).toBeNull();
  });

  test("returns null when trigger is missing", () => {
    const statement = JSON.stringify({ action: "do something" });
    expect(parsePlaybookStatement(statement)).toBeNull();
  });

  test("returns null when action is missing", () => {
    const statement = JSON.stringify({ trigger: "test" });
    expect(parsePlaybookStatement(statement)).toBeNull();
  });

  test("returns null when trigger is not a string", () => {
    const statement = JSON.stringify({ trigger: 42, action: "test" });
    expect(parsePlaybookStatement(statement)).toBeNull();
  });

  test("returns null when action is not a string", () => {
    const statement = JSON.stringify({ trigger: "test", action: true });
    expect(parsePlaybookStatement(statement)).toBeNull();
  });

  test("defaults invalid autonomyLevel to draft", () => {
    const statement = JSON.stringify({
      trigger: "test",
      action: "act",
      autonomyLevel: "invalid_level",
    });

    const result = parsePlaybookStatement(statement);
    expect(result).not.toBeNull();
    expect(result!.autonomyLevel).toBe("draft");
  });

  test("defaults non-string channel to wildcard", () => {
    const statement = JSON.stringify({
      trigger: "test",
      action: "act",
      channel: 123,
    });

    const result = parsePlaybookStatement(statement);
    expect(result).not.toBeNull();
    expect(result!.channel).toBe("*");
  });

  test("defaults non-number priority to 0", () => {
    const statement = JSON.stringify({
      trigger: "test",
      action: "act",
      priority: "high",
    });

    const result = parsePlaybookStatement(statement);
    expect(result).not.toBeNull();
    expect(result!.priority).toBe(0);
  });

  test("accepts all valid autonomy levels", () => {
    for (const level of ["auto", "draft", "notify"] as const) {
      const statement = JSON.stringify({
        trigger: "test",
        action: "act",
        autonomyLevel: level,
      });
      const result = parsePlaybookStatement(statement);
      expect(result).not.toBeNull();
      expect(result!.autonomyLevel).toBe(level);
    }
  });
});

// ── compilePlaybooks ────────────────────────────────────────────────

describe("compilePlaybooks", () => {
  beforeEach(clearPlaybooks);

  test("returns empty result when no playbooks exist", () => {
    const result = compilePlaybooks();
    expect(result.text).toBe("");
    expect(result.totalCount).toBe(0);
    expect(result.includedCount).toBe(0);
  });

  test("compiles a single playbook into action-playbooks block", () => {
    insertPlaybookRow({
      trigger: "meeting request",
      action: "check calendar",
      channel: "*",
      autonomyLevel: "draft",
      priority: 0,
    });

    const result = compilePlaybooks();
    expect(result.totalCount).toBe(1);
    expect(result.includedCount).toBe(1);
    expect(result.text).toContain("<action-playbooks>");
    expect(result.text).toContain("</action-playbooks>");
    expect(result.text).toContain('WHEN "meeting request"');
    expect(result.text).toContain("all channels");
    expect(result.text).toContain("check calendar");
    expect(result.text).toContain("draft for review");
  });

  test("sorts playbooks by priority descending", () => {
    insertPlaybookRow({
      trigger: "low priority",
      action: "act-low",
      priority: 1,
    });
    insertPlaybookRow({
      trigger: "high priority",
      action: "act-high",
      priority: 10,
    });
    insertPlaybookRow({
      trigger: "medium priority",
      action: "act-med",
      priority: 5,
    });

    const result = compilePlaybooks();
    expect(result.includedCount).toBe(3);

    const lines = result.text.split("\n").filter((l) => l.startsWith("- WHEN"));
    expect(lines[0]).toContain("high priority");
    expect(lines[1]).toContain("medium priority");
    expect(lines[2]).toContain("low priority");
  });

  test("excludes inactive playbooks", () => {
    insertPlaybookRow({ trigger: "active", action: "yes", status: "active" });
    insertPlaybookRow({
      trigger: "superseded",
      action: "no",
      status: "superseded",
    });

    const result = compilePlaybooks();
    expect(result.includedCount).toBe(1);
    expect(result.text).toContain("active");
    expect(result.text).not.toContain("superseded");
  });

  test("excludes invalidated playbooks", () => {
    insertPlaybookRow({ trigger: "valid", action: "yes", invalidAt: null });
    insertPlaybookRow({
      trigger: "invalid",
      action: "no",
      invalidAt: Date.now(),
    });

    const result = compilePlaybooks();
    expect(result.includedCount).toBe(1);
    expect(result.text).toContain("valid");
    expect(result.text).not.toContain("invalid");
  });

  test("scopes playbooks by scopeId", () => {
    insertPlaybookRow({
      trigger: "default scope",
      action: "yes",
      scopeId: "default",
    });
    insertPlaybookRow({
      trigger: "other scope",
      action: "no",
      scopeId: "workspace-2",
    });

    const defaultResult = compilePlaybooks();
    expect(defaultResult.includedCount).toBe(1);
    expect(defaultResult.text).toContain("default scope");

    const otherResult = compilePlaybooks({ scopeId: "workspace-2" });
    expect(otherResult.includedCount).toBe(1);
    expect(otherResult.text).toContain("other scope");
  });

  test("skips rows with unparseable statements", () => {
    insertPlaybookRow({ trigger: "good", action: "ok" });
    // Insert a row with corrupted statement
    insertPlaybookRow({ statement: "not valid json", trigger: "bad" });

    const result = compilePlaybooks();
    expect(result.totalCount).toBe(2);
    expect(result.includedCount).toBe(1);
    expect(result.text).toContain("good");
  });

  test("renders correct autonomy labels", () => {
    insertPlaybookRow({
      trigger: "auto-trigger",
      action: "auto-act",
      autonomyLevel: "auto",
      priority: 3,
    });
    insertPlaybookRow({
      trigger: "draft-trigger",
      action: "draft-act",
      autonomyLevel: "draft",
      priority: 2,
    });
    insertPlaybookRow({
      trigger: "notify-trigger",
      action: "notify-act",
      autonomyLevel: "notify",
      priority: 1,
    });

    const result = compilePlaybooks();
    expect(result.text).toContain("execute automatically");
    expect(result.text).toContain("draft for review");
    expect(result.text).toContain("notify only");
  });

  test("renders channel name for non-wildcard channels", () => {
    insertPlaybookRow({
      trigger: "email rule",
      action: "handle",
      channel: "email",
    });

    const result = compilePlaybooks();
    expect(result.text).toContain("on email");
    expect(result.text).not.toContain("all channels");
  });

  test("returns empty text when all rows have unparseable statements", () => {
    insertPlaybookRow({ statement: "garbage1", trigger: "a" });
    insertPlaybookRow({ statement: "garbage2", trigger: "b" });

    const result = compilePlaybooks();
    expect(result.text).toBe("");
    expect(result.totalCount).toBe(2);
    expect(result.includedCount).toBe(0);
  });
});

// ── Tool edge cases not covered in playbook-tools.test.ts ───────────

describe("playbook tool edge cases", () => {
  beforeEach(clearPlaybooks);

  test("create uses memoryScopeId from context when present", async () => {
    const scopedCtx: ToolContext = { ...ctx, memoryScopeId: "custom-scope" };
    const result = await executePlaybookCreate(
      {
        trigger: "scoped trigger",
        action: "scoped action",
      },
      scopedCtx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Playbook created successfully");

    // Verify it's invisible to default scope
    const defaultList = await executePlaybookList({}, ctx);
    expect(defaultList.content).toContain("No playbooks found");

    // Visible to custom scope
    const scopedList = await executePlaybookList({}, scopedCtx);
    expect(scopedList.content).toContain("scoped trigger");
  });

  test("update detects collision with another playbook", async () => {
    const _r1 = await executePlaybookCreate(
      { trigger: "trigger A", action: "action A" },
      ctx,
    );
    const r2 = await executePlaybookCreate(
      { trigger: "trigger B", action: "action B" },
      ctx,
    );

    const idB = r2.content.match(/ID: (\S+)/)![1];

    // Try to update B to match A exactly
    const updateResult = await executePlaybookUpdate(
      {
        playbook_id: idB,
        trigger: "trigger A",
        action: "action A",
      },
      ctx,
    );

    expect(updateResult.isError).toBe(true);
    expect(updateResult.content).toContain("already exists");
  });

  test("delete soft-deletes by setting status to superseded", async () => {
    const createResult = await executePlaybookCreate(
      {
        trigger: "to delete",
        action: "remove me",
      },
      ctx,
    );
    const id = createResult.content.match(/ID: (\S+)/)![1];

    await executePlaybookDelete({ playbook_id: id }, ctx);

    // Row still exists in DB but with superseded status
    const row = getRawDb()
      .query("SELECT status, invalid_at FROM memory_items WHERE id = ?")
      .get(id) as { status: string; invalid_at: number | null };
    expect(row.status).toBe("superseded");
    expect(row.invalid_at).not.toBeNull();
  });

  test("list returns filtered empty message with filter description", async () => {
    await executePlaybookCreate(
      { trigger: "only email", action: "handle", channel: "email" },
      ctx,
    );

    const result = await executePlaybookList({ channel: "slack" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No playbooks found matching");
    expect(result.content).toContain("slack");
  });

  test("list sorts by priority descending", async () => {
    await executePlaybookCreate(
      { trigger: "low", action: "act", priority: 1 },
      ctx,
    );
    await executePlaybookCreate(
      { trigger: "high", action: "act", priority: 10 },
      ctx,
    );

    const result = await executePlaybookList({}, ctx);
    const lines = result.content
      .split("\n")
      .filter((l: string) => l.startsWith("- **"));
    expect(lines[0]).toContain("high");
    expect(lines[1]).toContain("low");
  });

  test("update with no changes still succeeds", async () => {
    const createResult = await executePlaybookCreate(
      {
        trigger: "unchanged",
        action: "same",
      },
      ctx,
    );
    const id = createResult.content.match(/ID: (\S+)/)![1];

    const result = await executePlaybookUpdate({ playbook_id: id }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Playbook updated successfully");
    expect(result.content).toContain("unchanged");
  });

  test("create rejects invalid autonomy_level gracefully by defaulting to draft", async () => {
    const result = await executePlaybookCreate(
      {
        trigger: "test",
        action: "test",
        autonomy_level: "invalid_level",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Autonomy: draft for review");
  });

  test("update ignores invalid autonomy_level and keeps current", async () => {
    const createResult = await executePlaybookCreate(
      {
        trigger: "test",
        action: "test",
        autonomy_level: "auto",
      },
      ctx,
    );
    const id = createResult.content.match(/ID: (\S+)/)![1];

    const result = await executePlaybookUpdate(
      {
        playbook_id: id,
        autonomy_level: "bogus",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Autonomy: execute automatically");
  });

  test("combined channel and category filter on list", async () => {
    await executePlaybookCreate(
      { trigger: "a", action: "a", channel: "email", category: "triage" },
      ctx,
    );
    await executePlaybookCreate(
      { trigger: "b", action: "b", channel: "slack", category: "triage" },
      ctx,
    );
    await executePlaybookCreate(
      {
        trigger: "c",
        action: "c",
        channel: "email",
        category: "notifications",
      },
      ctx,
    );

    const result = await executePlaybookList(
      { channel: "email", category: "triage" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Found 1 playbook");
    expect(result.content).toContain("**a**");
  });

  test("delete is scoped and does not affect other scopes", async () => {
    const scopedCtx: ToolContext = { ...ctx, memoryScopeId: "scope-A" };
    const createResult = await executePlaybookCreate(
      { trigger: "x", action: "y" },
      scopedCtx,
    );
    const id = createResult.content.match(/ID: (\S+)/)![1];

    // Try to delete from default scope
    const deleteResult = await executePlaybookDelete({ playbook_id: id }, ctx);
    expect(deleteResult.isError).toBe(true);
    expect(deleteResult.content).toContain("not found");

    // Delete from correct scope succeeds
    const correctDelete = await executePlaybookDelete(
      { playbook_id: id },
      scopedCtx,
    );
    expect(correctDelete.isError).toBe(false);
  });
});
