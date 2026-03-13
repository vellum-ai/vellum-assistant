/**
 * Tests for memory item CRUD HTTP endpoints.
 *
 * Covers: list with filters, get by ID, create + duplicate rejection,
 * update + fingerprint collision, delete + 404.
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

const testDir = mkdtempSync(join(tmpdir(), "memory-item-routes-test-"));

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

// Stub config loader
mock.module("../../config/loader.js", () => ({
  loadConfig: () => ({}),
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));

import { and, eq } from "drizzle-orm";

import { getDb, initializeDb, resetDb } from "../../memory/db.js";
import {
  memoryEmbeddings,
  memoryItems,
  memoryJobs,
} from "../../memory/schema.js";
import type { RouteContext } from "../http-router.js";
import { memoryItemRouteDefinitions } from "./memory-item-routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHandler(endpoint: string, method: string) {
  const routes = memoryItemRouteDefinitions();
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
  const url = new URL("http://localhost/v1/memory-items");
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

function insertItem(opts: {
  id: string;
  kind: string;
  subject: string;
  statement: string;
  status?: string;
  importance?: number;
  firstSeenAt?: number;
  lastSeenAt?: number;
  supersedes?: string;
  supersededBy?: string;
}) {
  const db = getDb();
  const now = Date.now();
  db.insert(memoryItems)
    .values({
      id: opts.id,
      kind: opts.kind,
      subject: opts.subject,
      statement: opts.statement,
      status: opts.status ?? "active",
      confidence: 0.95,
      importance: opts.importance ?? 0.8,
      fingerprint: `fp-${opts.id}`,
      verificationState: "user_confirmed",
      scopeId: "default",
      firstSeenAt: opts.firstSeenAt ?? now,
      lastSeenAt: opts.lastSeenAt ?? now,
      lastUsedAt: null,
    })
    .run();

  if (opts.supersedes || opts.supersededBy) {
    const set: Record<string, unknown> = {};
    if (opts.supersedes) set.supersedes = opts.supersedes;
    if (opts.supersededBy) set.supersededBy = opts.supersededBy;
    db.update(memoryItems).set(set).where(eq(memoryItems.id, opts.id)).run();
  }
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
    db.run("DELETE FROM memory_embeddings");
    db.run("DELETE FROM memory_item_sources");
    db.run("DELETE FROM memory_items");
    db.run("DELETE FROM memory_jobs");
  });

  afterAll(() => {
    resetDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  // =========================================================================
  // GET /v1/memory-items (list)
  // =========================================================================

  describe("GET /v1/memory-items", () => {
    const handler = getHandler("memory-items", "GET");

    test("returns empty list when no items", async () => {
      const ctx = makeCtx();
      const res = await handler(ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[]; total: number };
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });

    test("returns all active items by default", async () => {
      insertItem({
        id: "i1",
        kind: "preference",
        subject: "s1",
        statement: "st1",
      });
      insertItem({
        id: "i2",
        kind: "identity",
        subject: "s2",
        statement: "st2",
        status: "deleted",
      });

      const ctx = makeCtx();
      const res = await handler(ctx);
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
        kind: "preference",
        subject: "s1",
        statement: "st1",
        status: "active",
      });
      insertItem({
        id: "i2",
        kind: "identity",
        subject: "s2",
        statement: "st2",
        status: "deleted",
      });

      const ctx = makeCtx({ status: "all" });
      const res = await handler(ctx);
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
        kind: "preference",
        subject: "s1",
        statement: "st1",
      });
      insertItem({
        id: "i2",
        kind: "identity",
        subject: "s2",
        statement: "st2",
      });

      const ctx = makeCtx({ kind: "preference" });
      const res = await handler(ctx);
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.items[0].id).toBe("i1");
    });

    test("filters by search on subject and statement", async () => {
      insertItem({
        id: "i1",
        kind: "preference",
        subject: "dark mode",
        statement: "User prefers dark mode",
      });
      insertItem({
        id: "i2",
        kind: "identity",
        subject: "name",
        statement: "User name is Alice",
      });

      const ctx = makeCtx({ search: "dark" });
      const res = await handler(ctx);
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
        kind: "preference",
        subject: "s1",
        statement: "st1",
        lastSeenAt: 1000,
      });
      insertItem({
        id: "i2",
        kind: "preference",
        subject: "s2",
        statement: "st2",
        lastSeenAt: 2000,
      });
      insertItem({
        id: "i3",
        kind: "preference",
        subject: "s3",
        statement: "st3",
        lastSeenAt: 3000,
      });

      const ctx = makeCtx({ limit: "1", offset: "1" });
      const res = await handler(ctx);
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
        kind: "preference",
        subject: "s1",
        statement: "st1",
        firstSeenAt: 3000,
      });
      insertItem({
        id: "i2",
        kind: "preference",
        subject: "s2",
        statement: "st2",
        firstSeenAt: 1000,
      });

      const ctx = makeCtx({ sort: "firstSeenAt", order: "asc" });
      const res = await handler(ctx);
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
      };
      expect(body.items[0].id).toBe("i2");
      expect(body.items[1].id).toBe("i1");
    });

    test("rejects invalid kind filter", async () => {
      const ctx = makeCtx({ kind: "bogus" });
      const res = await handler(ctx);
      expect(res.status).toBe(400);
    });

    test("rejects invalid sort field", async () => {
      const ctx = makeCtx({ sort: "bogus" });
      const res = await handler(ctx);
      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // GET /v1/memory-items/:id
  // =========================================================================

  describe("GET /v1/memory-items/:id", () => {
    const handler = getHandler("memory-items/:id", "GET");

    test("returns item by ID", async () => {
      insertItem({
        id: "i1",
        kind: "preference",
        subject: "dark mode",
        statement: "Prefers dark mode",
      });

      const ctx = makeCtx({}, { id: "i1" });
      const res = await handler(ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        item: { id: string; subject: string };
      };
      expect(body.item.id).toBe("i1");
      expect(body.item.subject).toBe("dark mode");
    });

    test("returns 404 for non-existent item", async () => {
      const ctx = makeCtx({}, { id: "nonexistent" });
      const res = await handler(ctx);
      expect(res.status).toBe(404);
    });

    test("includes supersedesSubject when supersedes is set", async () => {
      insertItem({
        id: "old",
        kind: "preference",
        subject: "old pref",
        statement: "old",
      });
      insertItem({
        id: "new",
        kind: "preference",
        subject: "new pref",
        statement: "new",
      });

      // Set supersedes relationship manually
      getDb()
        .update(memoryItems)
        .set({ supersedes: "old" })
        .where(eq(memoryItems.id, "new"))
        .run();

      const ctx = makeCtx({}, { id: "new" });
      const res = await handler(ctx);
      const body = (await res.json()) as {
        item: { supersedesSubject?: string };
      };
      expect(body.item.supersedesSubject).toBe("old pref");
    });
  });

  // =========================================================================
  // POST /v1/memory-items
  // =========================================================================

  describe("POST /v1/memory-items", () => {
    const handler = getHandler("memory-items", "POST");

    test("creates a new memory item", async () => {
      const ctx = makeJsonCtx("memory-items", "POST", {
        kind: "preference",
        subject: "dark mode",
        statement: "User prefers dark mode",
      });
      const res = await handler(ctx);
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        item: { id: string; kind: string; subject: string; statement: string };
      };
      expect(body.item.kind).toBe("preference");
      expect(body.item.subject).toBe("dark mode");
      expect(body.item.statement).toBe("User prefers dark mode");
    });

    test("uses custom importance when provided", async () => {
      const ctx = makeJsonCtx("memory-items", "POST", {
        kind: "preference",
        subject: "importance test",
        statement: "Testing custom importance",
        importance: 0.5,
      });
      const res = await handler(ctx);
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        item: { importance: number };
      };
      expect(body.item.importance).toBe(0.5);
    });

    test("rejects duplicate fingerprint", async () => {
      const payload = {
        kind: "preference",
        subject: "dark mode",
        statement: "User prefers dark mode",
      };
      const ctx1 = makeJsonCtx("memory-items", "POST", payload);
      const res1 = await handler(ctx1);
      expect(res1.status).toBe(201);

      const ctx2 = makeJsonCtx("memory-items", "POST", payload);
      const res2 = await handler(ctx2);
      expect(res2.status).toBe(409);
    });

    test("rejects invalid kind", async () => {
      const ctx = makeJsonCtx("memory-items", "POST", {
        kind: "bogus",
        subject: "test",
        statement: "test",
      });
      const res = await handler(ctx);
      expect(res.status).toBe(400);
    });

    test("rejects missing subject", async () => {
      const ctx = makeJsonCtx("memory-items", "POST", {
        kind: "preference",
        statement: "test",
      });
      const res = await handler(ctx);
      expect(res.status).toBe(400);
    });

    test("rejects missing statement", async () => {
      const ctx = makeJsonCtx("memory-items", "POST", {
        kind: "preference",
        subject: "test",
      });
      const res = await handler(ctx);
      expect(res.status).toBe(400);
    });

    test("truncates long subject and statement", async () => {
      const longSubject = "a".repeat(200);
      const longStatement = "b".repeat(1000);
      const ctx = makeJsonCtx("memory-items", "POST", {
        kind: "preference",
        subject: longSubject,
        statement: longStatement,
      });
      const res = await handler(ctx);
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        item: { subject: string; statement: string };
      };
      expect(body.item.subject.length).toBeLessThanOrEqual(80);
      expect(body.item.statement.length).toBeLessThanOrEqual(500);
    });

    test("enqueues embed job on create", async () => {
      const ctx = makeJsonCtx("memory-items", "POST", {
        kind: "preference",
        subject: "embed test",
        statement: "Should enqueue embed job",
      });
      await handler(ctx);

      // Verify a memory job was enqueued
      const db = getDb();
      const jobs = db.select().from(memoryJobs).all();
      const embedJobs = jobs.filter(
        (j) => j.type === "embed_item" && j.status === "pending",
      );
      expect(embedJobs.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // PATCH /v1/memory-items/:id
  // =========================================================================

  describe("PATCH /v1/memory-items/:id", () => {
    const handler = getHandler("memory-items/:id", "PATCH");

    test("updates subject and statement", async () => {
      insertItem({
        id: "i1",
        kind: "preference",
        subject: "old subject",
        statement: "old statement",
      });

      const ctx = makeJsonCtx(
        "memory-items/i1",
        "PATCH",
        { subject: "new subject", statement: "new statement" },
        { id: "i1" },
      );
      const res = await handler(ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        item: { subject: string; statement: string };
      };
      expect(body.item.subject).toBe("new subject");
      expect(body.item.statement).toBe("new statement");
    });

    test("returns 404 for non-existent item", async () => {
      const ctx = makeJsonCtx(
        "memory-items/nonexistent",
        "PATCH",
        { subject: "test" },
        { id: "nonexistent" },
      );
      const res = await handler(ctx);
      expect(res.status).toBe(404);
    });

    test("detects fingerprint collision on update", async () => {
      insertItem({
        id: "i1",
        kind: "preference",
        subject: "first",
        statement: "first statement",
      });
      // Insert a second item using the create handler to get a real fingerprint
      const createHandler = getHandler("memory-items", "POST");
      const createCtx = makeJsonCtx("memory-items", "POST", {
        kind: "preference",
        subject: "second",
        statement: "second statement",
      });
      await createHandler(createCtx);

      // Now try to update i1 to match the second item's content
      // This should produce the same fingerprint as the second item
      const ctx = makeJsonCtx(
        "memory-items/i1",
        "PATCH",
        { subject: "second", statement: "second statement" },
        { id: "i1" },
      );
      const res = await handler(ctx);
      expect(res.status).toBe(409);
    });

    test("allows updating kind", async () => {
      insertItem({
        id: "i1",
        kind: "preference",
        subject: "test",
        statement: "test",
      });

      const ctx = makeJsonCtx(
        "memory-items/i1",
        "PATCH",
        { kind: "identity" },
        { id: "i1" },
      );
      const res = await handler(ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { item: { kind: string } };
      expect(body.item.kind).toBe("identity");
    });

    test("rejects invalid kind on update", async () => {
      insertItem({
        id: "i1",
        kind: "preference",
        subject: "test",
        statement: "test",
      });

      const ctx = makeJsonCtx(
        "memory-items/i1",
        "PATCH",
        { kind: "bogus" },
        { id: "i1" },
      );
      const res = await handler(ctx);
      expect(res.status).toBe(400);
    });

    test("enqueues embed job when statement changes", async () => {
      insertItem({
        id: "i1",
        kind: "preference",
        subject: "test",
        statement: "old statement",
      });

      // Clear jobs first
      getDb().run("DELETE FROM memory_jobs");

      const ctx = makeJsonCtx(
        "memory-items/i1",
        "PATCH",
        { statement: "new statement" },
        { id: "i1" },
      );
      await handler(ctx);

      const db = getDb();
      const jobs = db.select().from(memoryJobs).all();
      const embedJobs = jobs.filter(
        (j) => j.type === "embed_item" && j.status === "pending",
      );
      expect(embedJobs.length).toBe(1);
    });
  });

  // =========================================================================
  // DELETE /v1/memory-items/:id
  // =========================================================================

  describe("DELETE /v1/memory-items/:id", () => {
    const handler = getHandler("memory-items/:id", "DELETE");

    test("deletes item and returns 204", async () => {
      insertItem({
        id: "i1",
        kind: "preference",
        subject: "test",
        statement: "test",
      });

      const ctx = makeJsonCtx("memory-items/i1", "DELETE", null, { id: "i1" });
      const res = await handler(ctx);
      expect(res.status).toBe(204);

      // Verify the item is gone
      const db = getDb();
      const item = db
        .select()
        .from(memoryItems)
        .where(eq(memoryItems.id, "i1"))
        .get();
      expect(item).toBeUndefined();
    });

    test("returns 404 for non-existent item", async () => {
      const ctx = makeJsonCtx("memory-items/nonexistent", "DELETE", null, {
        id: "nonexistent",
      });
      const res = await handler(ctx);
      expect(res.status).toBe(404);
    });

    test("also deletes associated embeddings", async () => {
      insertItem({
        id: "i1",
        kind: "preference",
        subject: "test",
        statement: "test",
      });

      // Insert an embedding for this item
      const db = getDb();
      db.insert(memoryEmbeddings)
        .values({
          id: "emb-1",
          targetType: "item",
          targetId: "i1",
          provider: "test",
          model: "test-model",
          dimensions: 384,
          vectorJson: "[]",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .run();

      const ctx = makeJsonCtx("memory-items/i1", "DELETE", null, { id: "i1" });
      const res = await handler(ctx);
      expect(res.status).toBe(204);

      // Verify embedding is also gone
      const emb = db
        .select()
        .from(memoryEmbeddings)
        .where(
          and(
            eq(memoryEmbeddings.targetType, "item"),
            eq(memoryEmbeddings.targetId, "i1"),
          ),
        )
        .get();
      expect(emb).toBeUndefined();
    });
  });
});
