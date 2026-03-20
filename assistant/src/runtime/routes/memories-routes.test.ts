/**
 * Tests for simplified memory HTTP endpoints.
 *
 * Covers: list all sections, filter by section, search, delete observation
 * with cascade, create manual observation, 404 on nonexistent delete.
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

const testDir = mkdtempSync(join(tmpdir(), "memories-routes-test-"));

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

mock.module("../../config/loader.js", () => ({
  loadConfig: () => ({}),
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));

import { and, eq } from "drizzle-orm";

import { getDb, initializeDb, resetDb } from "../../memory/db.js";
import {
  conversations,
  memoryChunks,
  memoryEmbeddings,
  memoryEpisodes,
  memoryObservations,
  openLoops,
  timeContexts,
} from "../../memory/schema.js";
import type { RouteContext } from "../http-router.js";
import { memoriesRouteDefinitions } from "./memories-routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHandler(endpoint: string, method: string) {
  const routes = memoriesRouteDefinitions();
  const route = routes.find(
    (r) => r.endpoint === endpoint && r.method === method,
  );
  if (!route) throw new Error(`No route: ${method} ${endpoint}`);
  return route.handler;
}

function makeCtx(
  searchParams: Record<string, string> = {},
  params: Record<string, string> = {},
): RouteContext {
  const url = new URL("http://localhost/v1/memories");
  for (const [k, v] of Object.entries(searchParams)) {
    url.searchParams.set(k, v);
  }
  return {
    url,
    req: new Request(url),
    server: {} as ReturnType<typeof Bun.serve>,
    authContext: {} as never,
    params,
  };
}

function makeJsonCtx(
  endpoint: string,
  method: string,
  body: unknown,
  params: Record<string, string> = {},
): RouteContext {
  const url = new URL(`http://localhost/v1/${endpoint}`);
  return {
    url,
    req: new Request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    server: {} as ReturnType<typeof Bun.serve>,
    authContext: {} as never,
    params,
  };
}

/** Insert a conversation row so FK constraints on observations/episodes are satisfied. */
function insertConversation(id: string, title: string) {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({ id, title, createdAt: now, updatedAt: now })
    .run();
}

/** Insert an observation row directly into the DB. */
function insertObservation(opts: {
  id: string;
  conversationId: string;
  role?: string;
  content: string;
  modality?: string;
  source?: string;
  createdAt?: number;
}) {
  const db = getDb();
  db.insert(memoryObservations)
    .values({
      id: opts.id,
      scopeId: "default",
      conversationId: opts.conversationId,
      role: opts.role ?? "user",
      content: opts.content,
      modality: opts.modality ?? "text",
      source: opts.source ?? null,
      createdAt: opts.createdAt ?? Date.now(),
    })
    .run();
}

/** Insert a chunk row directly into the DB. */
function insertChunk(opts: {
  id: string;
  observationId: string;
  content: string;
}) {
  const db = getDb();
  db.insert(memoryChunks)
    .values({
      id: opts.id,
      scopeId: "default",
      observationId: opts.observationId,
      content: opts.content,
      tokenEstimate: Math.ceil(opts.content.length / 4),
      contentHash: `hash-${opts.id}`,
      createdAt: Date.now(),
    })
    .run();
}

/** Insert an episode row directly into the DB. */
function insertEpisode(opts: {
  id: string;
  conversationId: string;
  title: string;
  summary: string;
  source?: string;
  createdAt?: number;
}) {
  const db = getDb();
  const now = opts.createdAt ?? Date.now();
  db.insert(memoryEpisodes)
    .values({
      id: opts.id,
      scopeId: "default",
      conversationId: opts.conversationId,
      title: opts.title,
      summary: opts.summary,
      tokenEstimate: Math.ceil(opts.summary.length / 4),
      source: opts.source ?? null,
      startAt: now - 60_000,
      endAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** Insert a time context row directly into the DB. */
function insertTimeContext(opts: {
  id: string;
  summary: string;
  activeFrom?: number;
  activeUntil?: number;
  source?: string;
}) {
  const db = getDb();
  const now = Date.now();
  db.insert(timeContexts)
    .values({
      id: opts.id,
      scopeId: "default",
      summary: opts.summary,
      source: opts.source ?? "conversation",
      activeFrom: opts.activeFrom ?? now - 60_000,
      activeUntil: opts.activeUntil ?? now + 86_400_000, // default: 1 day from now
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** Insert an open loop row directly into the DB. */
function insertOpenLoop(opts: {
  id: string;
  summary: string;
  status?: string;
  source?: string;
  dueAt?: number | null;
}) {
  const db = getDb();
  const now = Date.now();
  db.insert(openLoops)
    .values({
      id: opts.id,
      scopeId: "default",
      summary: opts.summary,
      status: opts.status ?? "open",
      source: opts.source ?? "conversation",
      dueAt: opts.dueAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Memories Routes", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_embeddings");
    db.run("DELETE FROM memory_chunks");
    db.run("DELETE FROM memory_episodes");
    db.run("DELETE FROM memory_observations");
    db.run("DELETE FROM open_loops");
    db.run("DELETE FROM time_contexts");
    db.run("DELETE FROM memory_jobs");
    // Don't delete all conversations — some may be needed for FK constraints,
    // but we do clean up test conversations.
    db.run("DELETE FROM conversations");
  });

  afterAll(() => {
    resetDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  // =========================================================================
  // GET /v1/memories
  // =========================================================================

  describe("GET /v1/memories", () => {
    const handler = getHandler("memories", "GET");

    test("returns all four sections when no data", async () => {
      const ctx = makeCtx();
      const res = await handler(ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.observations).toBeDefined();
      expect(body.episodes).toBeDefined();
      expect(body.timeContexts).toBeDefined();
      expect(body.openLoops).toBeDefined();

      const obs = body.observations as { items: unknown[]; total: number };
      expect(obs.items).toEqual([]);
      expect(obs.total).toBe(0);
    });

    test("returns observations with conversation titles", async () => {
      insertConversation("conv-1", "Test Conversation");
      insertObservation({
        id: "obs-1",
        conversationId: "conv-1",
        content: "User likes TypeScript",
      });

      const ctx = makeCtx();
      const res = await handler(ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        observations: {
          items: Array<{
            id: string;
            conversationTitle: string | null;
            content: string;
          }>;
          total: number;
        };
      };
      expect(body.observations.total).toBe(1);
      expect(body.observations.items[0].id).toBe("obs-1");
      expect(body.observations.items[0].conversationTitle).toBe(
        "Test Conversation",
      );
      expect(body.observations.items[0].content).toBe(
        "User likes TypeScript",
      );
    });

    test("returns episodes with conversation titles", async () => {
      insertConversation("conv-2", "Episode Conversation");
      insertEpisode({
        id: "ep-1",
        conversationId: "conv-2",
        title: "Planning Session",
        summary: "Discussed project architecture",
      });

      const ctx = makeCtx();
      const res = await handler(ctx);
      const body = (await res.json()) as {
        episodes: {
          items: Array<{
            id: string;
            conversationTitle: string | null;
            title: string;
          }>;
          total: number;
        };
      };
      expect(body.episodes.total).toBe(1);
      expect(body.episodes.items[0].id).toBe("ep-1");
      expect(body.episodes.items[0].conversationTitle).toBe(
        "Episode Conversation",
      );
      expect(body.episodes.items[0].title).toBe("Planning Session");
    });

    test("returns only active time contexts", async () => {
      const now = Date.now();
      insertTimeContext({
        id: "tc-active",
        summary: "Active context",
        activeUntil: now + 86_400_000,
      });
      insertTimeContext({
        id: "tc-expired",
        summary: "Expired context",
        activeUntil: now - 1000,
      });

      const ctx = makeCtx();
      const res = await handler(ctx);
      const body = (await res.json()) as {
        timeContexts: {
          items: Array<{ id: string; summary: string }>;
          total: number;
        };
      };
      expect(body.timeContexts.total).toBe(1);
      expect(body.timeContexts.items[0].id).toBe("tc-active");
    });

    test("returns non-expired open loops", async () => {
      insertOpenLoop({
        id: "loop-open",
        summary: "Follow up on PR",
        status: "open",
      });
      insertOpenLoop({
        id: "loop-resolved",
        summary: "Already done",
        status: "resolved",
      });
      insertOpenLoop({
        id: "loop-expired",
        summary: "Too late",
        status: "expired",
      });

      const ctx = makeCtx();
      const res = await handler(ctx);
      const body = (await res.json()) as {
        openLoops: {
          items: Array<{ id: string; status: string }>;
          total: number;
        };
      };
      // Should include open + resolved, exclude expired
      expect(body.openLoops.total).toBe(2);
      const ids = body.openLoops.items.map((i) => i.id).sort();
      expect(ids).toEqual(["loop-open", "loop-resolved"]);
    });

    test("section=observations returns only observations", async () => {
      insertConversation("conv-s", "Section Test");
      insertObservation({
        id: "obs-s",
        conversationId: "conv-s",
        content: "Test obs",
      });
      insertEpisode({
        id: "ep-s",
        conversationId: "conv-s",
        title: "Test episode",
        summary: "summary",
      });

      const ctx = makeCtx({ section: "observations" });
      const res = await handler(ctx);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.observations).toBeDefined();
      expect(body.episodes).toBeUndefined();
      expect(body.timeContexts).toBeUndefined();
      expect(body.openLoops).toBeUndefined();
    });

    test("search filters across observation content", async () => {
      insertConversation("conv-f", "Filter Test");
      insertObservation({
        id: "obs-match",
        conversationId: "conv-f",
        content: "User prefers dark mode",
      });
      insertObservation({
        id: "obs-no-match",
        conversationId: "conv-f",
        content: "User uses Linux",
      });

      const ctx = makeCtx({ search: "dark" });
      const res = await handler(ctx);
      const body = (await res.json()) as {
        observations: { items: Array<{ id: string }>; total: number };
      };
      expect(body.observations.total).toBe(1);
      expect(body.observations.items[0].id).toBe("obs-match");
    });

    test("search filters across episode title and summary", async () => {
      insertConversation("conv-es", "Episode Search");
      insertEpisode({
        id: "ep-match",
        conversationId: "conv-es",
        title: "Architecture Review",
        summary: "Discussed deployment pipeline",
      });
      insertEpisode({
        id: "ep-no-match",
        conversationId: "conv-es",
        title: "Random Chat",
        summary: "Just chatting",
      });

      const ctx = makeCtx({ search: "pipeline" });
      const res = await handler(ctx);
      const body = (await res.json()) as {
        episodes: { items: Array<{ id: string }>; total: number };
      };
      expect(body.episodes.total).toBe(1);
      expect(body.episodes.items[0].id).toBe("ep-match");
    });

    test("rejects invalid section", async () => {
      const ctx = makeCtx({ section: "bogus" });
      const res = await handler(ctx);
      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // POST /v1/memories
  // =========================================================================

  describe("POST /v1/memories", () => {
    const handler = getHandler("memories", "POST");

    test("creates a new observation", async () => {
      // Insert a conversation so the most recent lookup has something
      insertConversation("conv-post", "Post Test");

      const ctx = makeJsonCtx("memories", "POST", {
        content: "User prefers tabs over spaces",
      });
      const res = await handler(ctx);
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        observation: {
          id: string;
          content: string;
          role: string;
          source: string;
        };
      };
      expect(body.observation.content).toBe("User prefers tabs over spaces");
      expect(body.observation.role).toBe("user");
      expect(body.observation.source).toBe("manual");
    });

    test("uses custom role when provided", async () => {
      insertConversation("conv-role", "Role Test");

      const ctx = makeJsonCtx("memories", "POST", {
        content: "Assistant noted a preference",
        role: "assistant",
      });
      const res = await handler(ctx);
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        observation: { role: string };
      };
      expect(body.observation.role).toBe("assistant");
    });

    test("rejects missing content", async () => {
      const ctx = makeJsonCtx("memories", "POST", {});
      const res = await handler(ctx);
      expect(res.status).toBe(400);
    });

    test("rejects empty content", async () => {
      const ctx = makeJsonCtx("memories", "POST", { content: "   " });
      const res = await handler(ctx);
      expect(res.status).toBe(400);
    });

    test("creates conversation if none exist", async () => {
      // No conversations in DB — should still succeed
      const ctx = makeJsonCtx("memories", "POST", {
        content: "A standalone memory",
      });
      const res = await handler(ctx);
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        observation: { id: string; conversationTitle: string | null };
      };
      expect(body.observation.id).toBeDefined();
      expect(body.observation.conversationTitle).toBe("Manual Memories");
    });
  });

  // =========================================================================
  // DELETE /v1/memories/:id
  // =========================================================================

  describe("DELETE /v1/memories/:id", () => {
    const handler = getHandler("memories/:id", "DELETE");

    test("deletes observation and its chunks, returns 204", async () => {
      insertConversation("conv-del", "Delete Test");
      insertObservation({
        id: "obs-del",
        conversationId: "conv-del",
        content: "To be deleted",
      });
      insertChunk({
        id: "chunk-del",
        observationId: "obs-del",
        content: "To be deleted",
      });

      const ctx = makeJsonCtx("memories/obs-del", "DELETE", null, {
        id: "obs-del",
      });
      const res = await handler(ctx);
      expect(res.status).toBe(204);

      // Verify observation is gone
      const db = getDb();
      const obs = db
        .select()
        .from(memoryObservations)
        .where(eq(memoryObservations.id, "obs-del"))
        .get();
      expect(obs).toBeUndefined();

      // Verify chunk is gone
      const chunk = db
        .select()
        .from(memoryChunks)
        .where(eq(memoryChunks.id, "chunk-del"))
        .get();
      expect(chunk).toBeUndefined();
    });

    test("deletes associated embeddings", async () => {
      insertConversation("conv-emb", "Embedding Test");
      insertObservation({
        id: "obs-emb",
        conversationId: "conv-emb",
        content: "Has embeddings",
      });
      insertChunk({
        id: "chunk-emb",
        observationId: "obs-emb",
        content: "Has embeddings",
      });

      // Insert embeddings for both the observation and the chunk
      const db = getDb();
      const now = Date.now();
      db.insert(memoryEmbeddings)
        .values({
          id: "emb-obs",
          targetType: "observation",
          targetId: "obs-emb",
          provider: "test",
          model: "test-model",
          dimensions: 384,
          vectorJson: "[]",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(memoryEmbeddings)
        .values({
          id: "emb-chunk",
          targetType: "chunk",
          targetId: "chunk-emb",
          provider: "test",
          model: "test-model",
          dimensions: 384,
          vectorJson: "[]",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const ctx = makeJsonCtx("memories/obs-emb", "DELETE", null, {
        id: "obs-emb",
      });
      const res = await handler(ctx);
      expect(res.status).toBe(204);

      // Verify observation embedding is gone
      const obsEmb = db
        .select()
        .from(memoryEmbeddings)
        .where(
          and(
            eq(memoryEmbeddings.targetType, "observation"),
            eq(memoryEmbeddings.targetId, "obs-emb"),
          ),
        )
        .get();
      expect(obsEmb).toBeUndefined();

      // Verify chunk embedding is gone
      const chunkEmb = db
        .select()
        .from(memoryEmbeddings)
        .where(
          and(
            eq(memoryEmbeddings.targetType, "chunk"),
            eq(memoryEmbeddings.targetId, "chunk-emb"),
          ),
        )
        .get();
      expect(chunkEmb).toBeUndefined();
    });

    test("returns 404 for non-existent observation", async () => {
      const ctx = makeJsonCtx("memories/nonexistent", "DELETE", null, {
        id: "nonexistent",
      });
      const res = await handler(ctx);
      expect(res.status).toBe(404);
    });
  });
});
