/**
 * Memory lifecycle E2E regression test (Simplified Memory Path).
 *
 * Verifies the simplified memory pipeline end-to-end:
 * - Observation storage and retrieval
 * - Memory brief compilation
 * - Archive recall with supporting_recall injection
 * - injectMemoryRecallAsUserBlock utility
 * - Stripping removes injected memory blocks
 */
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

import { DEFAULT_CONFIG } from "../config/defaults.js";

const testDir = mkdtempSync(join(tmpdir(), "memory-lifecycle-e2e-"));

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
}));

const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    enabled: true,
  },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

import { v4 as uuid } from "uuid";

import { stripUserTextBlocksByPrefix } from "../daemon/conversation-runtime-assembly.js";
import { buildArchiveRecall } from "../memory/archive-recall.js";
import { insertObservation } from "../memory/archive-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { injectMemoryRecallAsUserBlock } from "../memory/inject.js";
import { memoryEpisodes, memoryObservations } from "../memory/schema.js";
import type { Message } from "../providers/types.js";

describe("Memory lifecycle E2E (simplified path)", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_episodes");
    db.run("DELETE FROM memory_chunks");
    db.run("DELETE FROM memory_observations");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best effort cleanup
    }
  });

  test("observation storage and archive recall round-trip", () => {
    const db = getDb();
    const now = 1_701_100_000_000;
    const conversationId = "conv-lifecycle-obs";

    // Seed a conversation
    db.run(`
      INSERT INTO conversations (
        id, title, created_at, updated_at, total_input_tokens, total_output_tokens,
        total_estimated_cost, context_summary, context_compacted_message_count,
        context_compacted_at
      ) VALUES (
        '${conversationId}', 'Lifecycle test', ${now}, ${now}, 0, 0,
        0, NULL, 0, NULL
      )
    `);

    db.run(`
      INSERT INTO messages (id, conversation_id, role, content, created_at)
      VALUES ('msg-lifecycle-1', '${conversationId}', 'user',
        '${JSON.stringify([{ type: "text", text: "My preferred timezone is America/Los_Angeles." }]).replace(/'/g, "''")}',
        ${now + 10})
    `);

    // Store an observation via the archive store
    const result = insertObservation({
      conversationId,
      messageId: "msg-lifecycle-1",
      role: "user",
      content: "User preferred timezone is America/Los_Angeles",
      scopeId: "default",
      modality: "text",
      source: "test",
    });

    expect(result.observationId).toBeTruthy();

    // Verify observation is persisted
    const obs = db
      .select()
      .from(memoryObservations)
      .all()
      .find((o) => o.id === result.observationId);
    expect(obs).toBeDefined();
    expect(obs!.content).toContain("timezone");

    // Archive recall should find it when user references past context
    const recall = buildArchiveRecall(
      "default",
      "do you remember my timezone preference?",
    );

    expect(recall.trigger).toBe("explicit_past_reference");
    expect(recall.bullets.length).toBeGreaterThan(0);
    expect(recall.text).toContain("timezone");
  });

  test("episode recall returns supporting_recall block", () => {
    const db = getDb();
    const now = 1_701_100_000_000;
    const conversationId = "conv-lifecycle-episode";

    db.run(`
      INSERT INTO conversations (
        id, title, created_at, updated_at, total_input_tokens, total_output_tokens,
        total_estimated_cost, context_summary, context_compacted_message_count,
        context_compacted_at
      ) VALUES (
        '${conversationId}', 'Episode test', ${now}, ${now}, 0, 0,
        0, NULL, 0, NULL
      )
    `);

    // Insert an episode
    db.insert(memoryEpisodes)
      .values({
        id: uuid(),
        scopeId: "default",
        conversationId,
        title: "Kubernetes Setup",
        summary: "Deployed Kubernetes cluster on AWS EKS with 3 worker nodes",
        createdAt: now,
      })
      .run();

    const recall = buildArchiveRecall(
      "default",
      "do you remember the Kubernetes deployment?",
    );

    expect(recall.trigger).toBe("explicit_past_reference");
    expect(recall.text).toContain("<supporting_recall>");
    expect(recall.text).toContain("</supporting_recall>");
    expect(recall.text).toContain("Kubernetes");
  });

  test("injectMemoryRecallAsUserBlock prepends memory context", () => {
    const memoryText =
      "<memory_brief>\nUser timezone: America/Los_Angeles\n</memory_brief>";
    const originalMessages: Message[] = [
      {
        role: "user",
        content: [{ type: "text" as const, text: "What time is it?" }],
      },
    ];
    const injected = injectMemoryRecallAsUserBlock(
      originalMessages,
      memoryText,
    );

    expect(injected).toHaveLength(1);
    expect(injected[0].role).toBe("user");
    expect(injected[0].content).toHaveLength(2);
    const b0 = injected[0].content[0];
    const b1 = injected[0].content[1];
    expect(b0.type === "text" && b0.text).toBe(memoryText);
    expect(b1.type === "text" && b1.text).toBe("What time is it?");
  });

  test("stripping removes <memory_brief> block from injected recall", () => {
    const memoryText =
      "<memory_brief>\nUser timezone: America/Los_Angeles\n</memory_brief>";
    const originalMessages: Message[] = [
      {
        role: "user",
        content: [{ type: "text" as const, text: "Actual user request" }],
      },
    ];
    const injected = injectMemoryRecallAsUserBlock(
      originalMessages,
      memoryText,
    );

    // Verify injection
    expect(injected[0].content).toHaveLength(2);

    // Stripped by prefix-based stripping
    const cleaned = stripUserTextBlocksByPrefix(injected, [
      "<memory_brief>",
    ]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].content).toHaveLength(1);
    const cb0 = cleaned[0].content[0];
    expect(cb0.type === "text" && cb0.text).toBe("Actual user request");
  });

  test("injectMemoryRecallAsUserBlock is a no-op for empty text", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text" as const, text: "Hello" }],
      },
    ];
    const result = injectMemoryRecallAsUserBlock(messages, "");
    expect(result).toBe(messages); // Same reference — no modification
  });

  test("empty recall returns no injection text", () => {
    const recall = buildArchiveRecall(
      "default",
      "completely unrelated xyzzy topic",
    );

    expect(recall.bullets).toHaveLength(0);
    expect(recall.text).toBe("");
  });
});
