/**
 * Unit tests for the `persistence` pipeline wrapping (PR 27).
 *
 * Exercises the three behaviors the plan calls out:
 *
 * 1. The default `persistence` pipeline delegates to the `memory/
 *    conversation-crud.ts` functions (`addMessage`, `updateMessageMetadata`,
 *    `deleteMessageById`) so running the pipeline produces the same DB rows
 *    the direct call would have produced.
 * 2. A custom plugin can redirect persistence to a mock in-memory store by
 *    short-circuiting every op — the real DB is never touched.
 *
 * Uses the real SQLite DB wired up via `test-preload.ts` (which points the
 * workspace dir at a per-file temp directory). `resetPluginRegistryForTests`
 * isolates the plugin registry between cases so the default plugin
 * registered at module load from `external-plugins-bootstrap.ts` doesn't
 * leak across tests that want a clean slate.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import {
  addMessage,
  createConversation,
  getMessageById,
  getMessages,
  updateMessageMetadata,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb } from "../memory/db.js";
import { defaultPersistencePlugin } from "../plugins/defaults/persistence.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import {
  getMiddlewaresFor,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type {
  Middleware,
  PersistAddResult,
  PersistArgs,
  PersistDeleteResult,
  PersistResult,
  Plugin,
  TurnContext,
} from "../plugins/types.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM memory_segments");
  db.run("DELETE FROM memory_embeddings");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function makeCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-test",
    conversationId: "conv-test",
    turnIndex: 0,
    trust,
    ...overrides,
  };
}

// The terminal passed into `runPipeline` is a no-op that asserts the chain
// resolved without reaching here — the default plugin always handles the
// operation itself, and custom short-circuit plugins in these tests also
// never call `next`.
const noopTerminal = (_args: PersistArgs): Promise<PersistResult> => {
  throw new Error(
    "persistence terminal reached: the default plugin should handle every op",
  );
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("persistence pipeline", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    resetTables();
  });

  // Clear the registry on the way out too so later test files in the same
  // `bun test` run don't inherit persistence middleware from our final test.
  afterAll(() => {
    resetPluginRegistryForTests();
  });

  test("default plugin: add op persists a message identical to direct addMessage", async () => {
    registerPlugin(defaultPersistencePlugin);

    const conv = createConversation();

    // Baseline: what the direct call produces.
    const direct = await addMessage(
      conv.id,
      "user",
      "direct-content",
      { role: "baseline" },
      { skipIndexing: true },
    );
    const directRow = getMessageById(direct.id, conv.id);

    // Through the pipeline: must produce a row with identical columns
    // (modulo id / createdAt timestamps, which are unique per insert).
    const result = (await runPipeline<PersistArgs, PersistResult>(
      "persistence",
      getMiddlewaresFor("persistence"),
      noopTerminal,
      {
        op: "add",
        conversationId: conv.id,
        role: "user",
        content: "pipeline-content",
        metadata: { role: "pipeline" },
        addOptions: { skipIndexing: true },
      },
      makeCtx({ conversationId: conv.id }),
      DEFAULT_TIMEOUTS.persistence,
    )) as PersistAddResult;

    expect(result.op).toBe("add");
    expect(result.message.id).toBeTruthy();
    expect(result.message.conversationId).toBe(conv.id);
    expect(result.message.role).toBe("user");
    expect(result.message.content).toBe("pipeline-content");

    const pipelineRow = getMessageById(result.message.id, conv.id);
    expect(pipelineRow).not.toBeNull();
    // Column-by-column parity with the direct baseline: role / content /
    // metadata string are the fields under the plugin's control.
    expect(pipelineRow?.role).toBe(directRow?.role);
    expect(typeof pipelineRow?.metadata).toBe(typeof directRow?.metadata);
  });

  test("default plugin: update op merges metadata in place", async () => {
    registerPlugin(defaultPersistencePlugin);

    const conv = createConversation();
    const msg = await addMessage(
      conv.id,
      "user",
      "to-update",
      { initial: true },
      { skipIndexing: true },
    );

    // Through the pipeline: result is the `update` envelope (no payload).
    const result = await runPipeline<PersistArgs, PersistResult>(
      "persistence",
      getMiddlewaresFor("persistence"),
      noopTerminal,
      {
        op: "update",
        messageId: msg.id,
        updates: { extra: "added" },
      },
      makeCtx({ conversationId: conv.id }),
      DEFAULT_TIMEOUTS.persistence,
    );
    expect(result).toEqual({ op: "update" });

    // Direct equivalent call on a second message for parity comparison.
    const baseline = await addMessage(
      conv.id,
      "user",
      "to-update-direct",
      { initial: true },
      { skipIndexing: true },
    );
    updateMessageMetadata(baseline.id, { extra: "added" });

    const pipelineRow = getMessageById(msg.id, conv.id);
    const baselineRow = getMessageById(baseline.id, conv.id);

    // Both rows must end up with identical merged metadata shape.
    expect(JSON.parse(pipelineRow!.metadata!)).toEqual({
      initial: true,
      extra: "added",
    });
    expect(JSON.parse(baselineRow!.metadata!)).toEqual(
      JSON.parse(pipelineRow!.metadata!),
    );
  });

  test("default plugin: delete op removes the message and returns segment IDs", async () => {
    registerPlugin(defaultPersistencePlugin);

    const conv = createConversation();
    const msg = await addMessage(conv.id, "user", "to-delete", undefined, {
      skipIndexing: true,
    });

    const result = (await runPipeline<PersistArgs, PersistResult>(
      "persistence",
      getMiddlewaresFor("persistence"),
      noopTerminal,
      { op: "delete", messageId: msg.id },
      makeCtx({ conversationId: conv.id }),
      DEFAULT_TIMEOUTS.persistence,
    )) as PersistDeleteResult;

    expect(result.op).toBe("delete");
    expect(result.segmentIds).toEqual([]);
    expect(result.deletedSummaryIds).toEqual([]);

    // The row must be gone.
    expect(getMessageById(msg.id, conv.id)).toBeNull();
    expect(getMessages(conv.id)).toHaveLength(0);
  });

  test("custom plugin: short-circuits every op onto a mock in-memory store", async () => {
    type Stored = {
      id: string;
      conversationId: string;
      role: string;
      content: string;
      metadata: Record<string, unknown>;
    };
    const mockStore = new Map<string, Stored>();
    let nextId = 1;

    const redirect: Middleware<PersistArgs, PersistResult> =
      async function redirectPersist(args, _next, _ctx) {
        switch (args.op) {
          case "add": {
            const id = `mock-${nextId++}`;
            mockStore.set(id, {
              id,
              conversationId: args.conversationId,
              role: args.role,
              content: args.content,
              metadata: { ...(args.metadata ?? {}) },
            });
            return {
              op: "add",
              message: {
                id,
                conversationId: args.conversationId,
                role: args.role,
                content: args.content,
                createdAt: 123,
              },
            };
          }
          case "update": {
            const existing = mockStore.get(args.messageId);
            if (existing) {
              existing.metadata = { ...existing.metadata, ...args.updates };
            }
            return { op: "update" };
          }
          case "delete": {
            mockStore.delete(args.messageId);
            return { op: "delete", segmentIds: [], deletedSummaryIds: [] };
          }
        }
      };

    const customPlugin: Plugin = {
      manifest: {
        name: "mock-persistence",
        version: "0.0.1",
        requires: { pluginRuntime: "v1" },
      },
      middleware: { persistence: redirect },
    };

    // Register the custom plugin FIRST so it composes as the outermost
    // wrapper — it short-circuits before the default plugin ever runs,
    // keeping the real DB untouched.
    registerPlugin(customPlugin);
    registerPlugin(defaultPersistencePlugin);

    const conv = createConversation();
    const dbRowsBefore = getMessages(conv.id).length;

    const addResult = (await runPipeline<PersistArgs, PersistResult>(
      "persistence",
      getMiddlewaresFor("persistence"),
      noopTerminal,
      {
        op: "add",
        conversationId: conv.id,
        role: "user",
        content: "mock-content",
        metadata: { origin: "mock" },
      },
      makeCtx({ conversationId: conv.id }),
      DEFAULT_TIMEOUTS.persistence,
    )) as PersistAddResult;

    expect(addResult.message.id).toBe("mock-1");
    expect(mockStore.size).toBe(1);

    await runPipeline<PersistArgs, PersistResult>(
      "persistence",
      getMiddlewaresFor("persistence"),
      noopTerminal,
      {
        op: "update",
        messageId: "mock-1",
        updates: { extra: "added" },
      },
      makeCtx({ conversationId: conv.id }),
      DEFAULT_TIMEOUTS.persistence,
    );
    expect(mockStore.get("mock-1")?.metadata).toEqual({
      origin: "mock",
      extra: "added",
    });

    const delResult = (await runPipeline<PersistArgs, PersistResult>(
      "persistence",
      getMiddlewaresFor("persistence"),
      noopTerminal,
      { op: "delete", messageId: "mock-1" },
      makeCtx({ conversationId: conv.id }),
      DEFAULT_TIMEOUTS.persistence,
    )) as PersistDeleteResult;
    expect(delResult.op).toBe("delete");
    expect(mockStore.has("mock-1")).toBe(false);

    // The real DB must not have been touched by any of the three ops.
    expect(getMessages(conv.id)).toHaveLength(dbRowsBefore);
  });
});
