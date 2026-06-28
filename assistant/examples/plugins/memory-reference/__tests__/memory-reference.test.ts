/**
 * Exercises the memory-reference plugin against the public host-facet contract
 * ALONE: remember → recall, per-turn `<memory>` injection, and turn-commit
 * consolidation, all driven through hand-rolled in-memory implementations of the
 * `@vellumai/plugin-api` facets. If the plugin ever reached for an `assistant/`
 * internal, these fakes could not satisfy it — so a passing test is the proof
 * the contract surface is sufficient.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type {
  InitContext,
  PluginHost,
  PluginJob,
  TurnCommitContext,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import init from "../hooks/init.js";
import turnCommit from "../hooks/turn-commit.js";
import userPromptSubmit from "../hooks/user-prompt-submit.js";
import { resetRuntime } from "../src/state.js";
import recallTool from "../tools/recall.js";
import rememberTool from "../tools/remember.js";

// ─── In-memory host facets (the public contract, nothing more) ───────────────

/**
 * A deterministic bag-of-words embedding: each distinct token maps to a fixed
 * dimension, and the vector counts token occurrences. Cosine similarity then
 * tracks lexical overlap — enough to make "remember X" retrievable by a query
 * that mentions X, with no real model.
 */
function makeEmbedder(): {
  embed: (texts: string[]) => Promise<number[][]>;
  size: number;
} {
  const vocab = new Map<string, number>();
  const size = 256;
  const vectorize = (text: string): number[] => {
    const v = new Array<number>(size).fill(0);
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length === 0) continue;
      let dim = vocab.get(raw);
      if (dim === undefined) {
        dim = vocab.size % size;
        vocab.set(raw, dim);
      }
      v[dim] = (v[dim] ?? 0) + 1;
    }
    return v;
  };
  return {
    size,
    embed: async (texts: string[]) => texts.map(vectorize),
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface StoredPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

/**
 * Host-namespace prefix the in-memory store enforces. Stands in for the real
 * host's `plugin_<id>_<hash>_` scheme — the exact bytes don't matter, only that
 * the store qualifies names with THIS prefix and rejects any statement that
 * touches a table outside it. Deliberately NOT `plugin_memoryreference_` so a
 * regression where the plugin hardcodes the old prefix (instead of deriving it
 * from `host.store.qualify`) is caught here rather than only against the real
 * daemon.
 */
const TEST_TABLE_PREFIX = "plugin_memref_test_";

/**
 * Pull the table names a statement references, so the fake store can reject any
 * outside its namespace — the same boundary the real `assertScopedToPlugin`
 * enforces, scoped to the handful of SQL shapes this plugin issues
 * (CREATE TABLE / CREATE INDEX … ON / INSERT INTO / FROM).
 */
function referencedTables(sql: string): string[] {
  const names: string[] = [];
  const patterns = [
    /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([A-Za-z0-9_]+)/gi,
    /\bcreate\s+index\s+(?:if\s+not\s+exists\s+)?[A-Za-z0-9_]+\s+on\s+([A-Za-z0-9_]+)/gi,
    /\binto\s+([A-Za-z0-9_]+)/gi,
    /\bfrom\s+([A-Za-z0-9_]+)/gi,
  ];
  for (const re of patterns) {
    for (const m of sql.matchAll(re)) {
      if (m[1]) names.push(m[1].toLowerCase());
    }
  }
  return names;
}

/**
 * Minimal table store keyed by the SQL shapes the plugin actually issues, with
 * namespace enforcement: `qualify` hands back a `TEST_TABLE_PREFIX`-prefixed
 * name and every statement is rejected if it references a table outside that
 * prefix — so the test fails if the plugin ever hardcodes a prefix that does
 * not match what `qualify` returns.
 */
function makeStore() {
  const rows = new Map<string, Record<string, unknown>>();
  const applied = new Set<string>();
  const assertScoped = (sql: string): void => {
    for (const table of referencedTables(sql)) {
      if (!table.startsWith(TEST_TABLE_PREFIX)) {
        throw new Error(
          `cross-namespace access: "${table}" is outside "${TEST_TABLE_PREFIX}"`,
        );
      }
    }
  };
  return {
    rows,
    facet: {
      qualify: (name: string): string => `${TEST_TABLE_PREFIX}${name}`,
      migrate(
        migrations: {
          name: string;
          up: (exec: (sql: string, params?: unknown[]) => void) => void;
        }[],
      ) {
        for (const m of migrations) {
          if (applied.has(m.name)) continue;
          // The in-memory store has no schema to build, but it DOES enforce the
          // namespace on every DDL statement, exactly as the real store does.
          m.up((sql: string) => assertScoped(sql));
          applied.add(m.name);
        }
      },
      exec(sql: string, params: unknown[] = []) {
        assertScoped(sql);
        if (/INSERT\s+OR\s+REPLACE\s+INTO/i.test(sql)) {
          const [id, conversation_id, text, created_at] = params as [
            string,
            string,
            string,
            number,
          ];
          rows.set(id, { id, conversation_id, text, created_at });
          return;
        }
        throw new Error(`unexpected exec: ${sql}`);
      },
      query<T = Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ): T[] {
        assertScoped(sql);
        if (/SELECT[\s\S]+FROM[\s\S]+WHERE\s+id\s+IN/i.test(sql)) {
          return (params as string[])
            .map((id) => rows.get(id))
            .filter(
              (r): r is Record<string, unknown> => r !== undefined,
            ) as T[];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    },
  };
}

function makeVectorStore() {
  const collections = new Map<string, StoredPoint[]>();
  return {
    collections,
    facet: {
      async collection(name: string, _opts: { vectorSize: number }) {
        if (!collections.has(name)) collections.set(name, []);
        const points = collections.get(name)!;
        return {
          async upsert(newPoints: StoredPoint[]) {
            for (const p of newPoints) {
              const idx = points.findIndex((e) => e.id === p.id);
              const entry: StoredPoint = { ...p, payload: p.payload ?? {} };
              if (idx >= 0) points[idx] = entry;
              else points.push(entry);
            }
          },
          async search(vector: number[], limit: number) {
            return points
              .map((p) => ({
                id: p.id,
                score: cosine(vector, p.vector),
                payload: p.payload,
              }))
              .sort((x, y) => y.score - x.score)
              .slice(0, limit);
          },
          async delete(ids: string[]) {
            for (const id of ids) {
              const idx = points.findIndex((e) => e.id === id);
              if (idx >= 0) points.splice(idx, 1);
            }
          },
        };
      },
    },
  };
}

interface HistoryRow {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  metadata: string | null;
}

function makeHistory(messages: HistoryRow[]) {
  return {
    async getConversation() {
      return null;
    },
    async getRecentMessages(conversationId: string, n: number) {
      return messages
        .filter((m) => m.conversationId === conversationId)
        .slice(-n);
    },
    async getMessages(conversationId: string) {
      return {
        messages: messages.filter((m) => m.conversationId === conversationId),
        hasMore: false,
      };
    },
  };
}

function makeJobs() {
  const handlers = new Map<string, (job: PluginJob) => void | Promise<void>>();
  const queue: PluginJob[] = [];
  return {
    queue,
    facet: {
      enqueue(type: string, payload: Record<string, unknown>) {
        const id = `job_${queue.length}`;
        queue.push({ type, payload, attempts: 0 });
        return id;
      },
      registerHandler(
        type: string,
        handler: (job: PluginJob) => void | Promise<void>,
      ) {
        handlers.set(type, handler);
      },
    },
    async drain() {
      while (queue.length > 0) {
        const job = queue.shift()!;
        const handler = handlers.get(job.type);
        if (handler) await handler(job);
      }
    },
  };
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

interface Harness {
  host: PluginHost;
  store: ReturnType<typeof makeStore>;
  vectorStore: ReturnType<typeof makeVectorStore>;
  jobs: ReturnType<typeof makeJobs>;
  history: HistoryRow[];
}

function makeHarness(historyRows: HistoryRow[] = []): Harness {
  const store = makeStore();
  const vectorStore = makeVectorStore();
  const embedder = makeEmbedder();
  const jobs = makeJobs();
  const history = historyRows;
  const host = {
    store: store.facet,
    embeddings: { embed: embedder.embed },
    vectorStore: vectorStore.facet,
    history: makeHistory(history),
    jobs: jobs.facet,
  } as unknown as PluginHost;
  return { host, store, vectorStore, jobs, history };
}

function initCtx(host: PluginHost): InitContext {
  return {
    config: {},
    logger: silentLogger,
    pluginStorageDir: "/tmp/memory-reference-test",
    assistantVersion: "0.8.0",
    host,
  };
}

const toolCtx = (conversationId: string) => ({
  conversationId,
  workingDir: "/tmp",
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("memory-reference plugin", () => {
  beforeEach(() => {
    resetRuntime();
  });

  test("remember → recall round-trips a fact through the public facets", async () => {
    const h = makeHarness();
    await init(initCtx(h.host));

    const remembered = await rememberTool.execute(
      { text: "The user prefers dark roast coffee in the morning." },
      toolCtx("conv-1") as never,
    );
    expect(remembered.isError).toBe(false);
    expect(h.store.rows.size).toBe(1);

    const recalled = await recallTool.execute(
      { query: "what coffee does the user like" },
      toolCtx("conv-1") as never,
    );
    expect(recalled.isError).toBe(false);
    expect(recalled.content).toContain("dark roast coffee");
  });

  test("derives its table name from host.store.qualify (no hardcoded prefix)", async () => {
    // The store enforces `TEST_TABLE_PREFIX` (not `plugin_memoryreference_`), so
    // init's migration DDL and remember/recall succeed ONLY because the plugin
    // qualifies its table name through the host. A hardcoded prefix would be
    // rejected as cross-namespace by the store — the failure mode FIX 3 closes.
    const h = makeHarness();
    await init(initCtx(h.host));

    const remembered = await rememberTool.execute(
      { text: "Namespaced through the host facet." },
      toolCtx("conv-ns") as never,
    );
    expect(remembered.isError).toBe(false);
    expect(h.store.rows.size).toBe(1);

    const recalled = await recallTool.execute(
      { query: "namespaced host facet" },
      toolCtx("conv-ns") as never,
    );
    expect(recalled.isError).toBe(false);
    expect(recalled.content).toContain("Namespaced through the host facet.");
  });

  test("recall returns nothing before anything is remembered", async () => {
    const h = makeHarness();
    await init(initCtx(h.host));

    const recalled = await recallTool.execute(
      { query: "anything" },
      toolCtx("conv-1") as never,
    );
    expect(recalled.isError).toBe(false);
    expect(recalled.content).toContain("No relevant memories");
  });

  test("user-prompt-submit injects a <memory> block for a relevant prompt", async () => {
    const h = makeHarness();
    await init(initCtx(h.host));
    await rememberTool.execute(
      { text: "The user lives in Berlin and works as an architect." },
      toolCtx("conv-1") as never,
    );

    const latestMessages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Where do I live again?" }],
      },
    ];
    const ctx: UserPromptSubmitContext = {
      conversationId: "conv-1",
      userMessageId: "msg-1",
      requestId: "req-1",
      modelProfileKey: null,
      isNonInteractive: false,
      prompt: "Where do I live again?",
      originalMessages: latestMessages.slice(),
      latestMessages,
      logger: silentLogger,
    };

    await userPromptSubmit(ctx);

    expect(ctx.latestMessages.length).toBe(2);
    const injected = ctx.latestMessages[0]!;
    expect(injected.role).toBe("user");
    const block = injected.content[0];
    expect(block?.type).toBe("text");
    expect((block as { text: string }).text).toContain("<memory>");
    expect((block as { text: string }).text).toContain("Berlin");
  });

  test("user-prompt-submit injects nothing when no memory is relevant", async () => {
    const h = makeHarness();
    await init(initCtx(h.host));

    const latestMessages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Hello there." }],
      },
    ];
    const ctx: UserPromptSubmitContext = {
      conversationId: "conv-1",
      userMessageId: "msg-1",
      requestId: "req-1",
      modelProfileKey: null,
      isNonInteractive: false,
      prompt: "Hello there.",
      originalMessages: latestMessages.slice(),
      latestMessages,
      logger: silentLogger,
    };

    await userPromptSubmit(ctx);
    expect(ctx.latestMessages.length).toBe(1);
  });

  test("turn-commit enqueues a consolidation job that, when drained, stores a fact", async () => {
    const historyRows: HistoryRow[] = [
      {
        id: "msg-user",
        conversationId: "conv-1",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Remember that my dog is named Pixel." },
        ]),
        createdAt: Date.now(),
        metadata: null,
      },
    ];
    const h = makeHarness(historyRows);
    await init(initCtx(h.host));

    const ctx: TurnCommitContext = {
      conversationId: "conv-1",
      userMessageId: "msg-user",
      messages: [],
      turnCount: 1,
      isNonInteractive: false,
      logger: silentLogger,
    };
    await turnCommit(ctx);

    // The hook only enqueues — no fact is written synchronously.
    expect(h.jobs.queue.length).toBe(1);
    expect(h.store.rows.size).toBe(0);

    // Draining the worker queue runs the registered handler, which consolidates.
    await h.jobs.drain();
    expect(h.store.rows.size).toBe(1);

    const recalled = await recallTool.execute(
      { query: "what is my dog's name" },
      toolCtx("conv-1") as never,
    );
    expect(recalled.content).toContain("Pixel");
  });

  test("hooks no-op gracefully when init ran without a host", async () => {
    await init({
      config: {},
      logger: silentLogger,
      pluginStorageDir: "/tmp/x",
      assistantVersion: "0.8.0",
      // no host
    });

    const latestMessages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hi" }],
      },
    ];
    const ctx: UserPromptSubmitContext = {
      conversationId: "conv-1",
      userMessageId: "msg-1",
      requestId: "req-1",
      modelProfileKey: null,
      isNonInteractive: false,
      prompt: "hi",
      originalMessages: latestMessages.slice(),
      latestMessages,
      logger: silentLogger,
    };
    // Should not throw even though the runtime was never installed.
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages.length).toBe(1);
  });
});
