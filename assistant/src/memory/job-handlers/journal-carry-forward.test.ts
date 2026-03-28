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

const testDir = mkdtempSync(join(tmpdir(), "journal-carry-forward-test-"));

mock.module("../../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Track enqueueMemoryJob calls
const enqueuedJobs: Array<{ type: string; payload: Record<string, unknown> }> =
  [];

mock.module("../jobs-store.js", () => {
  const actual =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../jobs-store.js") as typeof import("../jobs-store.js");
  return {
    ...actual,
    enqueueMemoryJob: (type: string, payload: Record<string, unknown>) => {
      enqueuedJobs.push({ type, payload });
      return "mock-job-id";
    },
  };
});

// Mock the provider
let mockProviderResponse: unknown = null;

mock.module("../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => {
    if (!mockProviderResponse) return null;
    return {
      sendMessage: async () => mockProviderResponse,
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

import { eq } from "drizzle-orm";

import { getDb, initializeDb, resetDb } from "../db.js";
import type { MemoryJob } from "../jobs-store.js";
import { memoryItems } from "../schema.js";
import { journalCarryForwardJob } from "./journal-carry-forward.js";

function makeJob(payload: Record<string, unknown>): MemoryJob {
  return {
    id: "test-job-id",
    type: "journal_carry_forward",
    payload,
    status: "running",
    attempts: 0,
    deferrals: 0,
    runAfter: Date.now(),
    lastError: null,
    startedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeProviderResponse(
  items: Array<{
    kind: string;
    subject: string;
    statement: string;
    importance: number;
  }>,
) {
  return {
    content: [
      {
        type: "tool_use" as const,
        id: "tool-1",
        name: "store_journal_memories",
        input: { items },
      },
    ],
    model: "test-model",
    stop_reason: "tool_use",
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

beforeAll(() => {
  initializeDb();
});

beforeEach(() => {
  resetDb();
  initializeDb();
  // Clear memory items table between tests
  getDb().delete(memoryItems).run();
  enqueuedJobs.length = 0;
  mockProviderResponse = null;
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("journalCarryForwardJob", () => {
  test("extracts memory items from journal content", async () => {
    mockProviderResponse = makeProviderResponse([
      {
        kind: "identity",
        subject: "Therapy breakthrough",
        statement:
          "Had a major realization in therapy about patterns of avoidance",
        importance: 0.9,
      },
      {
        kind: "event",
        subject: "Growth milestone",
        statement:
          "First time feeling genuinely at peace with uncertainty about the future",
        importance: 0.85,
      },
    ]);

    await journalCarryForwardJob(
      makeJob({
        journalContent: "Today in therapy I had a breakthrough...",
        userSlug: "testuser",
        filename: "2025-03-15-therapy.md",
        scopeId: "test-scope",
      }),
    );

    const db = getDb();
    const items = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.scopeId, "test-scope"))
      .all();

    expect(items).toHaveLength(2);
  });

  test("items have importance >= 0.7", async () => {
    mockProviderResponse = makeProviderResponse([
      {
        kind: "preference",
        subject: "Minor detail",
        statement: "Some minor logistical preference",
        importance: 0.3, // Below 0.7 -- should be floored
      },
      {
        kind: "identity",
        subject: "Core realization",
        statement: "A deeply personal insight",
        importance: 0.95,
      },
    ]);

    await journalCarryForwardJob(
      makeJob({
        journalContent: "Some journal content...",
        userSlug: "testuser",
        filename: "entry.md",
        scopeId: "test-scope",
      }),
    );

    const db = getDb();
    const items = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.scopeId, "test-scope"))
      .all();

    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.importance).toBeGreaterThanOrEqual(0.7);
    }
  });

  test('items have sourceType "journal_carry_forward"', async () => {
    mockProviderResponse = makeProviderResponse([
      {
        kind: "journal",
        subject: "Reflection",
        statement: "A meaningful reflection on growth",
        importance: 0.8,
      },
    ]);

    await journalCarryForwardJob(
      makeJob({
        journalContent: "Reflecting on my journey...",
        userSlug: "testuser",
        filename: "reflection.md",
        scopeId: "test-scope",
      }),
    );

    const db = getDb();
    const items = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.scopeId, "test-scope"))
      .all();

    expect(items).toHaveLength(1);
    expect(items[0].sourceType).toBe("journal_carry_forward");
  });

  test('items have verificationState "user_confirmed"', async () => {
    mockProviderResponse = makeProviderResponse([
      {
        kind: "identity",
        subject: "Self knowledge",
        statement: "I know who I am",
        importance: 0.9,
      },
    ]);

    await journalCarryForwardJob(
      makeJob({
        journalContent: "I know who I am...",
        userSlug: "testuser",
        filename: "knowing.md",
        scopeId: "test-scope",
      }),
    );

    const db = getDb();
    const items = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.scopeId, "test-scope"))
      .all();

    expect(items).toHaveLength(1);
    expect(items[0].verificationState).toBe("user_confirmed");
  });

  test("deduplicates items by fingerprint", async () => {
    mockProviderResponse = makeProviderResponse([
      {
        kind: "identity",
        subject: "Duplicate item",
        statement: "Exact same statement",
        importance: 0.8,
      },
    ]);

    // Run twice with the same content
    const job = makeJob({
      journalContent: "Same content...",
      userSlug: "testuser",
      filename: "dup.md",
      scopeId: "test-scope",
    });

    await journalCarryForwardJob(job);
    await journalCarryForwardJob(job);

    const db = getDb();
    const items = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.scopeId, "test-scope"))
      .all();

    // Should only have 1 item despite running twice
    expect(items).toHaveLength(1);
  });

  test("enqueues embed_item jobs for new items", async () => {
    mockProviderResponse = makeProviderResponse([
      {
        kind: "event",
        subject: "Milestone",
        statement: "Reached a significant milestone",
        importance: 0.85,
      },
    ]);

    await journalCarryForwardJob(
      makeJob({
        journalContent: "Today was a milestone...",
        userSlug: "testuser",
        filename: "milestone.md",
        scopeId: "test-scope",
      }),
    );

    const embedJobs = enqueuedJobs.filter((j) => j.type === "embed_item");
    expect(embedJobs).toHaveLength(1);
    expect(embedJobs[0].payload.itemId).toBeDefined();
  });

  test("skips invalid kinds", async () => {
    mockProviderResponse = makeProviderResponse([
      {
        kind: "nonsense_kind",
        subject: "Invalid",
        statement: "Should be skipped",
        importance: 0.9,
      },
      {
        kind: "identity",
        subject: "Valid item",
        statement: "Should be kept",
        importance: 0.9,
      },
    ]);

    await journalCarryForwardJob(
      makeJob({
        journalContent: "Content...",
        userSlug: "testuser",
        filename: "kinds.md",
        scopeId: "test-scope",
      }),
    );

    const db = getDb();
    const items = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.scopeId, "test-scope"))
      .all();

    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("identity");
  });

  test("returns early when journalContent is missing", async () => {
    mockProviderResponse = makeProviderResponse([]);

    await journalCarryForwardJob(
      makeJob({
        userSlug: "testuser",
        filename: "missing.md",
        scopeId: "test-scope",
      }),
    );

    const db = getDb();
    const items = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.scopeId, "test-scope"))
      .all();

    expect(items).toHaveLength(0);
  });
});
