import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "reducer-store-test-"));

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

import { initializeDb, resetDb } from "../memory/db.js";
import { getSqlite } from "../memory/db-connection.js";
import { resetTestTables } from "../memory/raw-query.js";
import {
  applyReducerResult,
  getActiveOpenLoops,
  getActiveTimeContexts,
} from "../memory/reducer-store.js";
import type { ReducerResult } from "../memory/reducer-types.js";

initializeDb();

// ── Helpers ──────────────────────────────────────────────────────────

const SCOPE = "test-scope";
const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function insertConversation(id: string): void {
  const raw = getSqlite();
  raw.run(
    `INSERT INTO conversations (id, title, created_at, updated_at, conversation_type, source, memory_scope_id, is_auto_title)
     VALUES (?, 'Test', ?, ?, 'standard', 'user', ?, 1)`,
    [id, NOW, NOW, SCOPE],
  );
}

function insertMessage(opts: {
  id: string;
  conversationId: string;
  role?: string;
  content?: string;
  createdAt?: number;
}): void {
  const raw = getSqlite();
  raw.run(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.conversationId,
      opts.role ?? "user",
      opts.content ?? "test message",
      opts.createdAt ?? NOW,
    ],
  );
}

function getRawConversation(conversationId: string): Record<string, unknown> {
  const raw = getSqlite();
  return raw
    .query(`SELECT * FROM conversations WHERE id = ?`)
    .get(conversationId) as Record<string, unknown>;
}

function getAllTimeContexts(): Array<Record<string, unknown>> {
  const raw = getSqlite();
  return raw.query(`SELECT * FROM time_contexts`).all() as Array<
    Record<string, unknown>
  >;
}

function getAllOpenLoops(): Array<Record<string, unknown>> {
  const raw = getSqlite();
  return raw.query(`SELECT * FROM open_loops`).all() as Array<
    Record<string, unknown>
  >;
}

function setDirtyTail(conversationId: string, messageId: string): void {
  const raw = getSqlite();
  raw.run(
    `UPDATE conversations SET memory_dirty_tail_since_message_id = ? WHERE id = ?`,
    [messageId, conversationId],
  );
}

function makeEmptyResult(): ReducerResult {
  return {
    timeContexts: [],
    openLoops: [],
    archiveObservations: [],
    archiveEpisodes: [],
  };
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
  resetTestTables("messages", "conversations", "time_contexts", "open_loops");
});

// ── Tests ────────────────────────────────────────────────────────────

describe("applyReducerResult", () => {
  describe("time context operations", () => {
    test("creates a new time context", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });

      const result: ReducerResult = {
        ...makeEmptyResult(),
        timeContexts: [
          {
            action: "create",
            summary: "User traveling next week",
            source: "conversation",
            activeFrom: NOW,
            activeUntil: NOW + 7 * 24 * HOUR,
          },
        ],
      };

      applyReducerResult({
        result,
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW,
      });

      const contexts = getAllTimeContexts();
      expect(contexts).toHaveLength(1);
      expect(contexts[0].summary).toBe("User traveling next week");
      expect(contexts[0].source).toBe("conversation");
      expect(contexts[0].scope_id).toBe(SCOPE);
      expect(contexts[0].active_from).toBe(NOW);
      expect(contexts[0].active_until).toBe(NOW + 7 * 24 * HOUR);
    });

    test("updates an existing time context", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });

      // First, create a time context directly
      const raw = getSqlite();
      raw.run(
        `INSERT INTO time_contexts (id, scope_id, summary, source, active_from, active_until, created_at, updated_at)
         VALUES ('tc-1', ?, 'Original summary', 'conversation', ?, ?, ?, ?)`,
        [SCOPE, NOW, NOW + HOUR, NOW, NOW],
      );

      const result: ReducerResult = {
        ...makeEmptyResult(),
        timeContexts: [
          {
            action: "update",
            id: "tc-1",
            summary: "Updated summary",
            activeUntil: NOW + 2 * HOUR,
          },
        ],
      };

      applyReducerResult({
        result,
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW + 100,
      });

      const contexts = getAllTimeContexts();
      expect(contexts).toHaveLength(1);
      expect(contexts[0].summary).toBe("Updated summary");
      expect(contexts[0].active_until).toBe(NOW + 2 * HOUR);
      expect(contexts[0].updated_at).toBe(NOW + 100);
    });

    test("resolves (deletes) a time context", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });

      const raw = getSqlite();
      raw.run(
        `INSERT INTO time_contexts (id, scope_id, summary, source, active_from, active_until, created_at, updated_at)
         VALUES ('tc-1', ?, 'Some context', 'conversation', ?, ?, ?, ?)`,
        [SCOPE, NOW, NOW + HOUR, NOW, NOW],
      );

      const result: ReducerResult = {
        ...makeEmptyResult(),
        timeContexts: [{ action: "resolve", id: "tc-1" }],
      };

      applyReducerResult({
        result,
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW,
      });

      expect(getAllTimeContexts()).toHaveLength(0);
    });
  });

  describe("open loop operations", () => {
    test("creates a new open loop", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });

      const result: ReducerResult = {
        ...makeEmptyResult(),
        openLoops: [
          {
            action: "create",
            summary: "Waiting for Bob's reply",
            source: "conversation",
            dueAt: NOW + 24 * HOUR,
          },
        ],
      };

      applyReducerResult({
        result,
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW,
      });

      const loops = getAllOpenLoops();
      expect(loops).toHaveLength(1);
      expect(loops[0].summary).toBe("Waiting for Bob's reply");
      expect(loops[0].status).toBe("open");
      expect(loops[0].source).toBe("conversation");
      expect(loops[0].due_at).toBe(NOW + 24 * HOUR);
      expect(loops[0].scope_id).toBe(SCOPE);
    });

    test("creates an open loop without dueAt", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });

      const result: ReducerResult = {
        ...makeEmptyResult(),
        openLoops: [
          {
            action: "create",
            summary: "Need to follow up on project",
            source: "conversation",
          },
        ],
      };

      applyReducerResult({
        result,
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW,
      });

      const loops = getAllOpenLoops();
      expect(loops).toHaveLength(1);
      expect(loops[0].due_at).toBeNull();
    });

    test("updates an existing open loop", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });

      const raw = getSqlite();
      raw.run(
        `INSERT INTO open_loops (id, scope_id, summary, status, source, due_at, created_at, updated_at)
         VALUES ('ol-1', ?, 'Original loop', 'open', 'conversation', NULL, ?, ?)`,
        [SCOPE, NOW, NOW],
      );

      const result: ReducerResult = {
        ...makeEmptyResult(),
        openLoops: [
          {
            action: "update",
            id: "ol-1",
            summary: "Updated loop summary",
            dueAt: NOW + 48 * HOUR,
          },
        ],
      };

      applyReducerResult({
        result,
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW + 100,
      });

      const loops = getAllOpenLoops();
      expect(loops).toHaveLength(1);
      expect(loops[0].summary).toBe("Updated loop summary");
      expect(loops[0].due_at).toBe(NOW + 48 * HOUR);
      expect(loops[0].updated_at).toBe(NOW + 100);
    });

    test("resolves an open loop with resolved status", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });

      const raw = getSqlite();
      raw.run(
        `INSERT INTO open_loops (id, scope_id, summary, status, source, created_at, updated_at)
         VALUES ('ol-1', ?, 'Pending loop', 'open', 'conversation', ?, ?)`,
        [SCOPE, NOW, NOW],
      );

      const result: ReducerResult = {
        ...makeEmptyResult(),
        openLoops: [{ action: "resolve", id: "ol-1", status: "resolved" }],
      };

      applyReducerResult({
        result,
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW,
      });

      const loops = getAllOpenLoops();
      expect(loops).toHaveLength(1);
      expect(loops[0].status).toBe("resolved");
    });

    test("resolves an open loop with expired status", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });

      const raw = getSqlite();
      raw.run(
        `INSERT INTO open_loops (id, scope_id, summary, status, source, created_at, updated_at)
         VALUES ('ol-1', ?, 'Expired loop', 'open', 'conversation', ?, ?)`,
        [SCOPE, NOW, NOW],
      );

      const result: ReducerResult = {
        ...makeEmptyResult(),
        openLoops: [{ action: "resolve", id: "ol-1", status: "expired" }],
      };

      applyReducerResult({
        result,
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW,
      });

      const loops = getAllOpenLoops();
      expect(loops).toHaveLength(1);
      expect(loops[0].status).toBe("expired");
    });
  });

  describe("checkpoint advancement", () => {
    test("advances memoryReducedThroughMessageId and memoryLastReducedAt", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });

      applyReducerResult({
        result: makeEmptyResult(),
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW + 500,
      });

      const conv = getRawConversation("conv-1");
      expect(conv.memory_reduced_through_message_id).toBe("msg-1");
      expect(conv.memory_last_reduced_at).toBe(NOW + 500);
    });

    test("clears dirty tail when fully caught up (no later messages)", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });
      setDirtyTail("conv-1", "msg-1");

      applyReducerResult({
        result: makeEmptyResult(),
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW,
      });

      const conv = getRawConversation("conv-1");
      expect(conv.memory_dirty_tail_since_message_id).toBeNull();
    });

    test("preserves dirty tail when messages exist after the reduced-through message", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });
      insertMessage({
        id: "msg-2",
        conversationId: "conv-1",
        createdAt: NOW + 1000,
      });
      setDirtyTail("conv-1", "msg-1");

      applyReducerResult({
        result: makeEmptyResult(),
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW,
      });

      const conv = getRawConversation("conv-1");
      // Dirty tail should remain since msg-2 still needs reducing
      expect(conv.memory_dirty_tail_since_message_id).toBe("msg-1");
      // But checkpoint should still advance
      expect(conv.memory_reduced_through_message_id).toBe("msg-1");
    });

    test("advances checkpoint when reducing through the middle of a conversation", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });
      insertMessage({
        id: "msg-2",
        conversationId: "conv-1",
        createdAt: NOW + 1000,
      });
      insertMessage({
        id: "msg-3",
        conversationId: "conv-1",
        createdAt: NOW + 2000,
      });
      setDirtyTail("conv-1", "msg-1");

      // Reduce through msg-2 (msg-3 still pending)
      applyReducerResult({
        result: makeEmptyResult(),
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-2",
        now: NOW + 3000,
      });

      const conv = getRawConversation("conv-1");
      expect(conv.memory_reduced_through_message_id).toBe("msg-2");
      expect(conv.memory_dirty_tail_since_message_id).toBe("msg-1");
      expect(conv.memory_last_reduced_at).toBe(NOW + 3000);
    });
  });

  describe("idempotent application", () => {
    test("applying the same result twice leaves state stable", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });
      setDirtyTail("conv-1", "msg-1");

      const result: ReducerResult = {
        ...makeEmptyResult(),
        openLoops: [
          {
            action: "create",
            summary: "Loop from first apply",
            source: "conversation",
          },
        ],
        timeContexts: [
          {
            action: "create",
            summary: "Context from first apply",
            source: "conversation",
            activeFrom: NOW,
            activeUntil: NOW + HOUR,
          },
        ],
      };

      const params = {
        result,
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW,
      };

      // First application
      applyReducerResult(params);

      const convAfterFirst = getRawConversation("conv-1");

      // Second application — create ops will insert new rows since UUIDs differ,
      // but checkpoint state should remain consistent
      applyReducerResult(params);

      const convAfterSecond = getRawConversation("conv-1");

      // Checkpoint columns should be stable
      expect(convAfterSecond.memory_reduced_through_message_id).toBe(
        convAfterFirst.memory_reduced_through_message_id,
      );
      expect(convAfterSecond.memory_last_reduced_at).toBe(
        convAfterFirst.memory_last_reduced_at,
      );
      expect(convAfterSecond.memory_dirty_tail_since_message_id).toBe(
        convAfterFirst.memory_dirty_tail_since_message_id,
      );
    });

    test("applying an empty result still advances the checkpoint", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });
      setDirtyTail("conv-1", "msg-1");

      applyReducerResult({
        result: makeEmptyResult(),
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW + 100,
      });

      const conv = getRawConversation("conv-1");
      expect(conv.memory_reduced_through_message_id).toBe("msg-1");
      expect(conv.memory_last_reduced_at).toBe(NOW + 100);
      expect(conv.memory_dirty_tail_since_message_id).toBeNull();

      // No side-effects on brief-state tables
      expect(getAllTimeContexts()).toHaveLength(0);
      expect(getAllOpenLoops()).toHaveLength(0);
    });
  });

  describe("mixed operations in a single result", () => {
    test("creates, updates, and resolves across both tables atomically", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });

      // Pre-existing rows to update/resolve
      const raw = getSqlite();
      raw.run(
        `INSERT INTO time_contexts (id, scope_id, summary, source, active_from, active_until, created_at, updated_at)
         VALUES ('tc-existing', ?, 'Will be updated', 'conversation', ?, ?, ?, ?)`,
        [SCOPE, NOW, NOW + HOUR, NOW, NOW],
      );
      raw.run(
        `INSERT INTO time_contexts (id, scope_id, summary, source, active_from, active_until, created_at, updated_at)
         VALUES ('tc-stale', ?, 'Will be resolved', 'conversation', ?, ?, ?, ?)`,
        [SCOPE, NOW - HOUR, NOW, NOW - HOUR, NOW - HOUR],
      );
      raw.run(
        `INSERT INTO open_loops (id, scope_id, summary, status, source, created_at, updated_at)
         VALUES ('ol-existing', ?, 'Will be resolved', 'open', 'conversation', ?, ?)`,
        [SCOPE, NOW, NOW],
      );

      const result: ReducerResult = {
        ...makeEmptyResult(),
        timeContexts: [
          {
            action: "create",
            summary: "New context",
            source: "conversation",
            activeFrom: NOW,
            activeUntil: NOW + 2 * HOUR,
          },
          {
            action: "update",
            id: "tc-existing",
            summary: "Updated context",
          },
          { action: "resolve", id: "tc-stale" },
        ],
        openLoops: [
          {
            action: "create",
            summary: "New loop",
            source: "conversation",
          },
          { action: "resolve", id: "ol-existing", status: "resolved" },
        ],
      };

      applyReducerResult({
        result,
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW + 200,
      });

      // Time contexts: 1 created + 1 updated (tc-stale deleted by resolve)
      const contexts = getAllTimeContexts();
      expect(contexts).toHaveLength(2);
      const updated = contexts.find((c) => c.id === "tc-existing");
      expect(updated?.summary).toBe("Updated context");
      const created = contexts.find((c) => c.id !== "tc-existing");
      expect(created?.summary).toBe("New context");

      // Open loops: 1 created + 1 resolved
      const loops = getAllOpenLoops();
      expect(loops).toHaveLength(2);
      const resolvedLoop = loops.find((l) => l.id === "ol-existing");
      expect(resolvedLoop?.status).toBe("resolved");
      const newLoop = loops.find((l) => l.id !== "ol-existing");
      expect(newLoop?.status).toBe("open");
      expect(newLoop?.summary).toBe("New loop");
    });
  });

  describe("archive candidates are ignored", () => {
    test("archive observations and episodes in result are not persisted", () => {
      insertConversation("conv-1");
      insertMessage({ id: "msg-1", conversationId: "conv-1", createdAt: NOW });

      const result: ReducerResult = {
        timeContexts: [],
        openLoops: [],
        archiveObservations: [{ content: "User likes coffee", role: "user" }],
        archiveEpisodes: [
          { title: "Coffee discussion", summary: "Talked about coffee" },
        ],
      };

      // Should not throw and should not attempt to write archive data
      applyReducerResult({
        result,
        conversationId: "conv-1",
        scopeId: SCOPE,
        reducedThroughMessageId: "msg-1",
        now: NOW,
      });

      // Checkpoint should still advance
      const conv = getRawConversation("conv-1");
      expect(conv.memory_reduced_through_message_id).toBe("msg-1");
    });
  });
});

describe("getActiveTimeContexts", () => {
  test("returns only non-expired time contexts for the scope", () => {
    const raw = getSqlite();
    // Active context (expires in the future)
    raw.run(
      `INSERT INTO time_contexts (id, scope_id, summary, source, active_from, active_until, created_at, updated_at)
       VALUES ('tc-active', ?, 'Active context', 'conversation', ?, ?, ?, ?)`,
      [SCOPE, NOW - HOUR, NOW + HOUR, NOW, NOW],
    );
    // Expired context
    raw.run(
      `INSERT INTO time_contexts (id, scope_id, summary, source, active_from, active_until, created_at, updated_at)
       VALUES ('tc-expired', ?, 'Expired context', 'conversation', ?, ?, ?, ?)`,
      [SCOPE, NOW - 2 * HOUR, NOW - HOUR, NOW, NOW],
    );
    // Different scope
    raw.run(
      `INSERT INTO time_contexts (id, scope_id, summary, source, active_from, active_until, created_at, updated_at)
       VALUES ('tc-other', 'other-scope', 'Other scope context', 'conversation', ?, ?, ?, ?)`,
      [NOW, NOW + HOUR, NOW, NOW],
    );

    const active = getActiveTimeContexts(SCOPE, NOW);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("tc-active");
    expect(active[0].summary).toBe("Active context");
  });
});

describe("getActiveOpenLoops", () => {
  test("returns only open loops for the scope", () => {
    const raw = getSqlite();
    // Open loop
    raw.run(
      `INSERT INTO open_loops (id, scope_id, summary, status, source, created_at, updated_at)
       VALUES ('ol-open', ?, 'Open loop', 'open', 'conversation', ?, ?)`,
      [SCOPE, NOW, NOW],
    );
    // Resolved loop
    raw.run(
      `INSERT INTO open_loops (id, scope_id, summary, status, source, created_at, updated_at)
       VALUES ('ol-resolved', ?, 'Resolved loop', 'resolved', 'conversation', ?, ?)`,
      [SCOPE, NOW, NOW],
    );
    // Different scope
    raw.run(
      `INSERT INTO open_loops (id, scope_id, summary, status, source, created_at, updated_at)
       VALUES ('ol-other', 'other-scope', 'Other scope loop', 'open', 'conversation', ?, ?)`,
      [NOW, NOW],
    );

    const active = getActiveOpenLoops(SCOPE);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("ol-open");
    expect(active[0].summary).toBe("Open loop");
    expect(active[0].status).toBe("open");
  });
});
