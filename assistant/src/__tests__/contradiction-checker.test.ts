import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { eq } from "drizzle-orm";

const testDir = mkdtempSync(join(tmpdir(), "contradiction-checker-test-"));

let nextRelationship = "ambiguous_contradiction";
let nextExplanation = "Statements likely conflict but need confirmation.";
let classifyCallCount = 0;

const classifyRelationshipMock = mock(async () => {
  classifyCallCount += 1;
  return {
    content: [
      {
        type: "tool_use" as const,
        id: "test-tool-use-id",
        name: "classify_relationship",
        input: {
          relationship: nextRelationship,
          explanation: nextExplanation,
        },
      },
    ],
    model: "claude-haiku-4-5-20251001",
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
});

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: () => ({
    sendMessage: classifyRelationshipMock,
  }),
  createTimeout: (ms: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timer),
    };
  },
  extractToolUse: (response: { content: Array<{ type: string }> }) => {
    return response.content.find(
      (b: { type: string }) => b.type === "tool_use",
    );
  },
  userMessage: (text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
  }),
}));

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

let mockConflictableKinds: string[] = [
  "preference",
  "profile",
  "constraint",
  "instruction",
  "style",
];

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    apiKeys: { anthropic: "test-key" },
    memory: {
      conflicts: {
        conflictableKinds: mockConflictableKinds,
      },
    },
  }),
}));

import { checkContradictions } from "../memory/contradiction-checker.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { memoryItemConflicts, memoryItems } from "../memory/schema.js";

beforeAll(() => {
  initializeDb();
});

beforeEach(() => {
  classifyCallCount = 0;
  mockConflictableKinds = [
    "preference",
    "profile",
    "constraint",
    "instruction",
    "style",
  ];
  const db = getDb();
  db.run("DELETE FROM memory_item_conflicts");
  db.run("DELETE FROM memory_item_sources");
  db.run("DELETE FROM memory_jobs");
  db.run("DELETE FROM memory_items");
});

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

function insertMemoryItem(params: {
  id: string;
  statement: string;
  scopeId?: string;
  status?: "active" | "pending_clarification";
  kind?: string;
}): void {
  const now = Date.now();
  const db = getDb();
  db.insert(memoryItems)
    .values({
      id: params.id,
      kind: params.kind ?? "preference",
      subject: "framework preference",
      statement: params.statement,
      status: params.status ?? "active",
      confidence: 0.8,
      importance: 0.7,
      fingerprint: `fp-${params.id}`,
      verificationState: "assistant_inferred",
      scopeId: params.scopeId ?? "default",
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .run();
}

describe("checkContradictions", () => {
  test("marks candidate pending and writes one conflict row for ambiguous contradictions", async () => {
    nextRelationship = "ambiguous_contradiction";
    nextExplanation = "Seems contradictory; ask user to choose.";

    insertMemoryItem({
      id: "item-existing-ambiguous",
      statement: "User prefers React for frontend work.",
      scopeId: "workspace-a",
    });
    insertMemoryItem({
      id: "item-candidate-ambiguous",
      statement: "User prefers Vue for frontend work.",
      scopeId: "workspace-a",
    });

    await checkContradictions("item-candidate-ambiguous");

    const db = getDb();
    const candidate = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-candidate-ambiguous"))
      .get();
    const existing = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-existing-ambiguous"))
      .get();
    const conflicts = db.select().from(memoryItemConflicts).all();

    expect(classifyCallCount).toBe(1);
    expect(candidate?.status).toBe("pending_clarification");
    expect(existing?.invalidAt).toBeNull();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].status).toBe("pending_clarification");
    expect(conflicts[0].existingItemId).toBe("item-existing-ambiguous");
    expect(conflicts[0].candidateItemId).toBe("item-candidate-ambiguous");
    expect(conflicts[0].relationship).toBe("ambiguous_contradiction");
    expect(conflicts[0].clarificationQuestion).toContain("Pending conflict:");
    expect(conflicts[0].clarificationQuestion).not.toContain(
      "I have conflicting notes",
    );
    expect(conflicts[0].clarificationQuestion).not.toContain(
      "Which one is correct?",
    );
  });

  test("keeps existing contradiction behavior and does not create conflict row", async () => {
    nextRelationship = "contradiction";
    nextExplanation = "The statements are directly incompatible.";

    insertMemoryItem({
      id: "item-existing-contradiction",
      statement: "User prefers dark mode.",
    });
    insertMemoryItem({
      id: "item-candidate-contradiction",
      statement: "User prefers light mode.",
    });

    await checkContradictions("item-candidate-contradiction");

    const db = getDb();
    const candidate = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-candidate-contradiction"))
      .get();
    const existing = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-existing-contradiction"))
      .get();
    const conflicts = db.select().from(memoryItemConflicts).all();

    expect(classifyCallCount).toBe(1);
    expect(candidate?.status).toBe("active");
    expect(typeof candidate?.validFrom).toBe("number");
    expect(typeof existing?.invalidAt).toBe("number");
    expect(conflicts).toHaveLength(0);
  });

  test("only evaluates contradiction candidates within the same scope", async () => {
    nextRelationship = "ambiguous_contradiction";
    nextExplanation = "Should not be used for this test.";

    insertMemoryItem({
      id: "item-existing-other-scope",
      statement: "Use Go for backend services.",
      scopeId: "workspace-b",
    });
    insertMemoryItem({
      id: "item-candidate-default-scope",
      statement: "Use Rust for backend services.",
      scopeId: "workspace-a",
    });

    await checkContradictions("item-candidate-default-scope");

    const db = getDb();
    const candidate = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-candidate-default-scope"))
      .get();
    const conflicts = db.select().from(memoryItemConflicts).all();

    expect(classifyCallCount).toBe(0);
    expect(candidate?.status).toBe("active");
    expect(conflicts).toHaveLength(0);
  });

  test("project kind ambiguous contradiction does not generate pending conflict with default config", async () => {
    nextRelationship = "ambiguous_contradiction";
    nextExplanation = "Project items may conflict but are not durable.";

    insertMemoryItem({
      id: "item-existing-project",
      statement: "The backend uses Node.js.",
      kind: "project",
    });
    insertMemoryItem({
      id: "item-candidate-project",
      statement: "The backend uses Deno.",
      kind: "project",
    });

    await checkContradictions("item-candidate-project");

    expect(classifyCallCount).toBe(0);
    const db = getDb();
    const conflicts = db.select().from(memoryItemConflicts).all();
    expect(conflicts).toHaveLength(0);
  });

  test("skips classification when item kind is not in conflictableKinds", async () => {
    mockConflictableKinds = ["instruction", "style"];
    nextRelationship = "ambiguous_contradiction";

    insertMemoryItem({
      id: "item-existing-ineligible",
      statement: "User prefers React for frontend work.",
    });
    insertMemoryItem({
      id: "item-candidate-ineligible",
      statement: "User prefers Vue for frontend work.",
    });

    await checkContradictions("item-candidate-ineligible");

    expect(classifyCallCount).toBe(0);
    const db = getDb();
    const conflicts = db.select().from(memoryItemConflicts).all();
    expect(conflicts).toHaveLength(0);
  });

  test("skips classification when candidate statement contains PR-tracking content", async () => {
    nextRelationship = "ambiguous_contradiction";

    insertMemoryItem({
      id: "item-existing-pr-tracking",
      statement: "Track PR #5526 for review.",
    });
    insertMemoryItem({
      id: "item-candidate-pr-tracking",
      statement: "Track PR #5525 for review.",
    });

    await checkContradictions("item-candidate-pr-tracking");

    expect(classifyCallCount).toBe(0);
    const db = getDb();
    const conflicts = db.select().from(memoryItemConflicts).all();
    expect(conflicts).toHaveLength(0);
  });

  test("durable preference contradiction still runs normal flow", async () => {
    nextRelationship = "ambiguous_contradiction";
    nextExplanation = "Both are valid preferences that conflict.";

    insertMemoryItem({
      id: "item-existing-durable",
      statement: "User prefers React for frontend work.",
    });
    insertMemoryItem({
      id: "item-candidate-durable",
      statement: "User prefers Vue for frontend work.",
    });

    await checkContradictions("item-candidate-durable");

    expect(classifyCallCount).toBe(1);
    const db = getDb();
    const conflicts = db.select().from(memoryItemConflicts).all();
    expect(conflicts).toHaveLength(1);
  });
});
