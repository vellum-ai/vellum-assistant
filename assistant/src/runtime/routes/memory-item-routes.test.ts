/**
 * Tests for memory item CRUD HTTP endpoints.
 *
 * Covers: list with filters, get by ID, create + duplicate rejection,
 * update + fingerprint collision, delete + 404.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Stub config loader — return a config with memory.v2.enabled=false so the
// v1 paths under test stay active.
mock.module("../../config/loader.js", () => ({
  loadConfig: () => mockConfig,
  getConfig: () => mockConfig,
  invalidateConfigCache: () => {},
}));

// ── Controllable mocks for semantic search ─────────────────────────────
const mockConfig: unknown = { memory: { v2: { enabled: false } } };

let mockBackendStatus: {
  enabled: boolean;
  provider: string | null;
  model: string | null;
} = { enabled: false, provider: null, model: null };

const mockEmbedResult: {
  provider: string;
  model: string;
  vectors: number[][];
} = { provider: "local", model: "test", vectors: [[0.1, 0.2, 0.3]] };

let mockHybridSearchResults: Array<{
  id: string;
  score: number;
  payload: Record<string, unknown>;
}> = [];

mock.module("../../memory/embedding-backend.js", () => ({
  getMemoryBackendStatus: async () => mockBackendStatus,
  embedWithBackend: async () => mockEmbedResult,
  generateSparseEmbedding: () => ({
    indices: [0, 1, 2],
    values: [0.5, 0.3, 0.2],
  }),
}));

mock.module("../../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    hybridSearch: async () => [...mockHybridSearchResults],
    searchWithFilter: async () => [...mockHybridSearchResults],
  }),
  initQdrantClient: () => {},
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

mock.module("../../memory/qdrant-circuit-breaker.js", () => ({
  withQdrantBreaker: async (fn: () => Promise<unknown>) => fn(),
}));

import { eq } from "drizzle-orm";

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { memoryGraphNodes, memoryJobs } from "../../memory/schema.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
import { ROUTES } from "./memory-item-routes.js";
import type { RouteDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRoute(endpoint: string, method: string): RouteDefinition {
  const route = ROUTES.find(
    (r: RouteDefinition) => r.endpoint === endpoint && r.method === method,
  );
  if (!route) throw new Error(`No route: ${method} ${endpoint}`);
  return route;
}

/**
 * Call a route handler and return a Response-like object for backward compat
 * with existing test assertions (res.status / res.json()).
 */
async function callHandler(
  route: RouteDefinition,
  opts: {
    queryParams?: Record<string, string>;
    pathParams?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<{ status: number; json: () => Promise<unknown> }> {
  try {
    const result = await route.handler({
      pathParams: opts.pathParams ?? {},
      queryParams: opts.queryParams ?? {},
      body: opts.body as Record<string, unknown>,
      headers: {},
    });
    const statusCode =
      route.responseStatus === "201"
        ? 201
        : route.responseStatus === "204"
          ? 204
          : 200;
    return {
      status: statusCode,
      json: async () => result,
    };
  } catch (err) {
    if (err instanceof BadRequestError) {
      return { status: 400, json: async () => ({ error: err.message }) };
    }
    if (err instanceof NotFoundError) {
      return { status: 404, json: async () => ({ error: err.message }) };
    }
    if (err instanceof ConflictError) {
      return { status: 409, json: async () => ({ error: err.message }) };
    }
    throw err;
  }
}

function insertItem(opts: {
  id: string;
  type: string;
  content: string;
  fidelity?: string;
  significance?: number;
  created?: number;
  lastAccessed?: number;
}) {
  const db = getDb();
  const now = Date.now();
  db.insert(memoryGraphNodes)
    .values({
      id: opts.id,
      content: opts.content,
      type: opts.type,
      created: opts.created ?? now,
      lastAccessed: opts.lastAccessed ?? now,
      lastConsolidated: now,
      eventDate: null,
      emotionalCharge: JSON.stringify({
        valence: 0,
        intensity: 0.1,
        decayCurve: "linear",
        decayRate: 0.05,
        originalIntensity: 0.1,
      }),
      fidelity: opts.fidelity ?? "vivid",
      confidence: 0.95,
      significance: opts.significance ?? 0.8,
      stability: 14,
      reinforcementCount: 0,
      lastReinforced: now,
      sourceConversations: JSON.stringify([]),
      sourceType: "direct",
      narrativeRole: null,
      partOfStory: null,
      imageRefs: null,
      scopeId: "default",
    })
    .run();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Memory Item Routes", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_graph_node_edits");
    db.run("DELETE FROM memory_graph_triggers");
    db.run("DELETE FROM memory_graph_edges");
    db.run("DELETE FROM memory_graph_nodes");
    db.run("DELETE FROM memory_jobs");
  });

  // =========================================================================
  // GET /v1/memory-items (list)
  // =========================================================================

  describe("GET /v1/memory-items", () => {
    const route = getRoute("memory-items", "GET");

    test("returns empty list when no items", async () => {
      const res = await callHandler(route);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[]; total: number };
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });

    test("returns all active items by default", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "s1\nst1",
      });
      insertItem({
        id: "i2",
        type: "episodic",
        content: "s2\nst2",
        fidelity: "gone",
      });

      const res = await callHandler(route);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.items.length).toBe(1);
      expect(body.items[0].id).toBe("i1");
    });

    test("returns items of all statuses when status=all", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "s1\nst1",
        fidelity: "vivid",
      });
      insertItem({
        id: "i2",
        type: "episodic",
        content: "s2\nst2",
        fidelity: "gone",
      });

      const res = await callHandler(route, { queryParams: { status: "all" } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };
      expect(body.total).toBe(2);
      expect(body.items.length).toBe(2);
      const ids = body.items.map((i) => i.id).sort();
      expect(ids).toEqual(["i1", "i2"]);
    });

    test("filters by kind", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "s1\nst1",
      });
      insertItem({
        id: "i2",
        type: "episodic",
        content: "s2\nst2",
      });

      const res = await callHandler(route, {
        queryParams: { kind: "semantic" },
      });
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.items[0].id).toBe("i1");
    });

    test("filters by search on content", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "dark mode\nUser prefers dark mode",
      });
      insertItem({
        id: "i2",
        type: "episodic",
        content: "name\nUser name is Alice",
      });

      const res = await callHandler(route, { queryParams: { search: "dark" } });
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.items[0].id).toBe("i1");
    });

    test("supports pagination with limit and offset", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "s1\nst1",
        lastAccessed: 1000,
      });
      insertItem({
        id: "i2",
        type: "semantic",
        content: "s2\nst2",
        lastAccessed: 2000,
      });
      insertItem({
        id: "i3",
        type: "semantic",
        content: "s3\nst3",
        lastAccessed: 3000,
      });

      const res = await callHandler(route, {
        queryParams: { limit: "1", offset: "1" },
      });
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };
      expect(body.total).toBe(3);
      expect(body.items.length).toBe(1);
      // Default sort is lastSeenAt desc, so offset 1 should be i2
      expect(body.items[0].id).toBe("i2");
    });

    test("supports sort by firstSeenAt ascending", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "s1\nst1",
        created: 3000,
      });
      insertItem({
        id: "i2",
        type: "semantic",
        content: "s2\nst2",
        created: 1000,
      });

      const res = await callHandler(route, {
        queryParams: { sort: "firstSeenAt", order: "asc" },
      });
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
      };
      expect(body.items[0].id).toBe("i2");
      expect(body.items[1].id).toBe("i1");
    });

    test("supports sort by importance descending", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "s1\nst1",
        significance: 0.3,
      });
      insertItem({
        id: "i2",
        type: "semantic",
        content: "s2\nst2",
        significance: 0.9,
      });

      const res = await callHandler(route, {
        queryParams: { sort: "importance", order: "desc" },
      });
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
      };
      expect(body.items[0].id).toBe("i2");
      expect(body.items[1].id).toBe("i1");
    });

    test("rejects invalid kind filter", async () => {
      const res = await callHandler(route, { queryParams: { kind: "bogus" } });
      expect(res.status).toBe(400);
    });

    test("rejects invalid sort field", async () => {
      const res = await callHandler(route, { queryParams: { sort: "bogus" } });
      expect(res.status).toBe(400);
    });

    // ── Semantic / hybrid search ──────────────────────────────────────

    test("uses semantic search when embedding backend is available", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "dark mode\nUser prefers dark mode",
      });
      insertItem({
        id: "i2",
        type: "episodic",
        content: "name\nUser name is Alice",
      });

      // Enable semantic search
      mockBackendStatus = {
        enabled: true,
        provider: "local",
        model: "test",
      };
      // Qdrant returns i2 first (higher relevance), then i1
      mockHybridSearchResults = [
        {
          id: "pt-2",
          score: 0.95,
          payload: { target_type: "graph_node", target_id: "i2" },
        },
        {
          id: "pt-1",
          score: 0.7,
          payload: { target_type: "graph_node", target_id: "i1" },
        },
      ];

      const res = await callHandler(route, {
        queryParams: { search: "alice" },
      });
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };

      // Results in Qdrant relevance order (i2 first)
      expect(body.items.length).toBe(2);
      expect(body.items[0].id).toBe("i2");
      expect(body.items[1].id).toBe("i1");
      expect(body.total).toBe(2);

      // Reset
      mockBackendStatus = { enabled: false, provider: null, model: null };
      mockHybridSearchResults = [];
    });

    test("falls back to SQL LIKE when backend is unavailable", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "dark mode\nUser prefers dark mode",
      });
      insertItem({
        id: "i2",
        type: "episodic",
        content: "name\nUser name is Alice",
      });

      // Backend unavailable
      mockBackendStatus = { enabled: false, provider: null, model: null };
      mockHybridSearchResults = [];

      const res = await callHandler(route, { queryParams: { search: "dark" } });
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };

      // SQL LIKE fallback finds "dark" in subject/statement
      expect(body.total).toBe(1);
      expect(body.items[0].id).toBe("i1");
    });

    test("semantic search respects pagination", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "s1\nfirst item",
      });
      insertItem({
        id: "i2",
        type: "semantic",
        content: "s2\nsecond item",
      });
      insertItem({
        id: "i3",
        type: "semantic",
        content: "s3\nthird item",
      });

      mockBackendStatus = {
        enabled: true,
        provider: "local",
        model: "test",
      };
      mockHybridSearchResults = [
        {
          id: "pt-1",
          score: 0.9,
          payload: { target_type: "graph_node", target_id: "i1" },
        },
        {
          id: "pt-2",
          score: 0.8,
          payload: { target_type: "graph_node", target_id: "i2" },
        },
        {
          id: "pt-3",
          score: 0.7,
          payload: { target_type: "graph_node", target_id: "i3" },
        },
      ];

      // Request page 2 (offset=1, limit=1)
      const res = await callHandler(route, {
        queryParams: { search: "item", limit: "1", offset: "1" },
      });
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };

      expect(body.items.length).toBe(1);
      expect(body.items[0].id).toBe("i2"); // second by relevance
      expect(body.total).toBe(3);

      // Reset
      mockBackendStatus = { enabled: false, provider: null, model: null };
      mockHybridSearchResults = [];
    });

    test("falls back to SQL when semantic returns empty results", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "dark mode\nUser prefers dark mode",
      });

      mockBackendStatus = {
        enabled: true,
        provider: "local",
        model: "test",
      };
      // Qdrant returns nothing
      mockHybridSearchResults = [];

      const res = await callHandler(route, { queryParams: { search: "dark" } });
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };

      // Falls through to SQL LIKE
      expect(body.total).toBe(1);
      expect(body.items[0].id).toBe("i1");

      // Reset
      mockBackendStatus = { enabled: false, provider: null, model: null };
      mockHybridSearchResults = [];
    });
  });

  // =========================================================================
  // GET /v1/memory-items/:id
  // =========================================================================

  describe("GET /v1/memory-items/:id", () => {
    const route = getRoute("memory-items/:id", "GET");

    test("returns item by ID", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "dark mode\nPrefers dark mode",
      });

      const res = await callHandler(route, {
        queryParams: {},
        pathParams: { id: "i1" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        item: { id: string; subject: string };
      };
      expect(body.item.id).toBe("i1");
      expect(body.item.subject).toBe("dark mode");
    });

    test("returns 404 for non-existent item", async () => {
      const res = await callHandler(route, {
        queryParams: {},
        pathParams: { id: "nonexistent" },
      });
      expect(res.status).toBe(404);
    });

    test("returns null for legacy supersedes/supersededBy fields", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "some content\nsome statement",
      });

      const res = await callHandler(route, {
        queryParams: {},
        pathParams: { id: "i1" },
      });
      const body = (await res.json()) as {
        item: { supersedes: unknown; supersededBy: unknown };
      };
      expect(body.item.supersedes).toBeNull();
      expect(body.item.supersededBy).toBeNull();
    });
  });

  // =========================================================================
  // POST /v1/memory-items
  // =========================================================================

  describe("POST /v1/memory-items", () => {
    const route = getRoute("memory-items", "POST");

    test("creates a new memory item", async () => {
      const res = await callHandler(route, {
        body: {
          kind: "semantic",
          subject: "dark mode",
          statement: "User prefers dark mode",
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        item: { id: string; kind: string; subject: string; statement: string };
      };
      expect(body.item.kind).toBe("semantic");
      expect(body.item.subject).toBe("dark mode");
      expect(body.item.statement).toBe("User prefers dark mode");
    });

    test("uses custom importance when provided", async () => {
      const res = await callHandler(route, {
        body: {
          kind: "semantic",
          subject: "importance test",
          statement: "Testing custom importance",
          importance: 0.5,
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        item: { importance: number };
      };
      expect(body.item.importance).toBe(0.5);
    });

    test("rejects duplicate content", async () => {
      const payload = {
        kind: "semantic",
        subject: "dark mode",
        statement: "User prefers dark mode",
      };
      const res1 = await callHandler(route, { body: payload });
      expect(res1.status).toBe(201);

      const res2 = await callHandler(route, { body: payload });
      expect(res2.status).toBe(409);
    });

    test("rejects invalid kind", async () => {
      const res = await callHandler(route, {
        body: {
          kind: "bogus",
          subject: "test",
          statement: "test",
        },
      });
      expect(res.status).toBe(400);
    });

    test("accepts missing subject (optional)", async () => {
      const res = await callHandler(route, {
        body: {
          kind: "semantic",
          statement: "test content without subject",
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        item: { subject: string; statement: string };
      };
      // When no subject, content has no newline, so subject and statement are the same
      expect(body.item.subject).toBe("test content without subject");
      expect(body.item.statement).toBe("test content without subject");
    });

    test("rejects missing statement", async () => {
      const res = await callHandler(route, {
        body: {
          kind: "semantic",
          subject: "test",
        },
      });
      expect(res.status).toBe(400);
    });

    test("preserves long subject and statement without truncation", async () => {
      const longSubject = "a".repeat(200);
      const longStatement = "b".repeat(1000);
      const res = await callHandler(route, {
        body: {
          kind: "semantic",
          subject: longSubject,
          statement: longStatement,
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        item: { subject: string; statement: string };
      };
      expect(body.item.subject).toBe(longSubject);
      expect(body.item.statement).toBe(longStatement);
    });

    test("enqueues embed job on create", async () => {
      await callHandler(route, {
        body: {
          kind: "semantic",
          subject: "embed test",
          statement: "Should enqueue embed job",
        },
      });

      // Verify a memory job was enqueued
      const db = getDb();
      const jobs = db.select().from(memoryJobs).all();
      const embedJobs = jobs.filter(
        (j) => j.type === "embed_graph_node" && j.status === "pending",
      );
      expect(embedJobs.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // PATCH /v1/memory-items/:id
  // =========================================================================

  describe("PATCH /v1/memory-items/:id", () => {
    const route = getRoute("memory-items/:id", "PATCH");

    test("updates subject and statement", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "old subject\nold statement",
      });

      const res = await callHandler(route, {
        pathParams: { id: "i1" },
        body: { subject: "new subject", statement: "new statement" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        item: { subject: string; statement: string };
      };
      expect(body.item.subject).toBe("new subject");
      expect(body.item.statement).toBe("new statement");
    });

    test("returns 404 for non-existent item", async () => {
      const res = await callHandler(route, {
        pathParams: { id: "nonexistent" },
        body: { subject: "test" },
      });
      expect(res.status).toBe(404);
    });

    test("detects content collision on update", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "first\nfirst statement",
      });
      // Insert a second item using the create handler to get a real node
      const createRoute = getRoute("memory-items", "POST");
      await callHandler(createRoute, {
        body: {
          kind: "semantic",
          subject: "second",
          statement: "second statement",
        },
      });

      // Now try to update i1 to match the second item's content
      // This should produce the same fingerprint as the second item
      const res = await callHandler(route, {
        pathParams: { id: "i1" },
        body: { subject: "second", statement: "second statement" },
      });
      expect(res.status).toBe(409);
    });

    test("allows updating kind", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "test\ntest",
      });

      const res = await callHandler(route, {
        pathParams: { id: "i1" },
        body: { kind: "episodic" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { item: { kind: string } };
      expect(body.item.kind).toBe("episodic");
    });

    test("rejects invalid kind on update", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "test\ntest",
      });

      const res = await callHandler(route, {
        pathParams: { id: "i1" },
        body: { kind: "bogus" },
      });
      expect(res.status).toBe(400);
    });

    test("enqueues embed job when statement changes", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "test\nold statement",
      });

      // Clear jobs first
      getDb().run("DELETE FROM memory_jobs");

      await callHandler(route, {
        pathParams: { id: "i1" },
        body: { statement: "new statement" },
      });

      const db = getDb();
      const jobs = db.select().from(memoryJobs).all();
      const embedJobs = jobs.filter(
        (j) => j.type === "embed_graph_node" && j.status === "pending",
      );
      expect(embedJobs.length).toBe(1);
    });
  });

  // =========================================================================
  // DELETE /v1/memory-items/:id
  // =========================================================================

  describe("DELETE /v1/memory-items/:id", () => {
    const route = getRoute("memory-items/:id", "DELETE");

    test("deletes item and returns 204", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "test\ntest",
      });

      const res = await callHandler(route, { pathParams: { id: "i1" } });
      expect(res.status).toBe(204);

      // Verify the node is soft-deleted (fidelity='gone')
      const db = getDb();
      const node = db
        .select()
        .from(memoryGraphNodes)
        .where(eq(memoryGraphNodes.id, "i1"))
        .get();
      expect(node).toBeDefined();
      expect(node?.fidelity).toBe("gone");
    });

    test("returns 404 for non-existent item", async () => {
      const res = await callHandler(route, {
        pathParams: { id: "nonexistent" },
      });
      expect(res.status).toBe(404);
    });

    test("enqueues delete_qdrant_vectors job on delete", async () => {
      insertItem({
        id: "i1",
        type: "semantic",
        content: "test\ntest",
      });

      const res = await callHandler(route, { pathParams: { id: "i1" } });
      expect(res.status).toBe(204);

      // Verify a delete_qdrant_vectors job was enqueued with graph_node targetType
      const db = getDb();
      const jobs = db.select().from(memoryJobs).all();
      const deleteJobs = jobs.filter(
        (j) => j.type === "delete_qdrant_vectors" && j.status === "pending",
      );
      expect(deleteJobs.length).toBe(1);
      const payload = JSON.parse(deleteJobs[0].payload);
      expect(payload.targetType).toBe("graph_node");
      expect(payload.targetId).toBe("i1");
    });
  });
});
