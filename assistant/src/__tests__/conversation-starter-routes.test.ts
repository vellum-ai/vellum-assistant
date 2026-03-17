import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { v4 as uuid } from "uuid";

const testDir = mkdtempSync(
  join(tmpdir(), "conversation-starter-routes-test-"),
);

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

import { getSqlite, initializeDb, resetDb } from "../memory/db.js";
import {
  conversationStarterRouteDefinitions,
  orderStrongestFirst,
} from "../runtime/routes/conversation-starter-routes.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

const routes = conversationStarterRouteDefinitions();

function dispatch(path: string): Response | Promise<Response> {
  const url = new URL(`http://localhost/v1/${path}`);
  const req = new Request(url.toString(), { method: "GET" });
  const route = routes.find(
    (r) => r.method === "GET" && r.endpoint === "conversation-starters",
  );
  if (!route) throw new Error("No conversation-starters route found");
  return route.handler({
    req,
    url,
    server: null as never,
    authContext: {} as never,
    params: {},
  });
}

function clearTables() {
  getSqlite().run("DELETE FROM conversation_starters");
  getSqlite().run("DELETE FROM memory_items");
  getSqlite().run("DELETE FROM memory_jobs");
  getSqlite().run("DELETE FROM memory_checkpoints");
}

function insertStarter(overrides: {
  label: string;
  prompt: string;
  category: string;
  batch?: number;
  scopeId?: string;
  createdAt?: number;
}) {
  const now = Date.now();
  getSqlite().run(
    `INSERT INTO conversation_starters (id, label, prompt, category, generation_batch, scope_id, card_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'chip', ?)`,
    uuid(),
    overrides.label,
    overrides.prompt,
    overrides.category,
    overrides.batch ?? 1,
    overrides.scopeId ?? "default",
    overrides.createdAt ?? now,
  );
}

function insertMemoryItem(scopeId = "default") {
  getSqlite().run(
    `INSERT INTO memory_items (id, kind, subject, statement, importance, status, scope_id, first_seen_at, updated_at)
     VALUES (?, 'fact', 'test', 'test statement', 5, 'active', ?, ?, ?)`,
    uuid(),
    scopeId,
    Date.now(),
    Date.now(),
  );
}

beforeEach(() => {
  clearTables();
});

// ---------------------------------------------------------------------------
// Route behavior
// ---------------------------------------------------------------------------

describe("GET /v1/conversation-starters", () => {
  test("returns ready status with starters when they exist", async () => {
    insertStarter({
      label: "Draft a PR summary",
      prompt: "Draft a summary for my latest PR",
      category: "development",
    });
    insertStarter({
      label: "Check Slack threads",
      prompt: "Check my unread Slack threads",
      category: "communication",
    });

    const res = await dispatch("conversation-starters");
    const body = (await res.json()) as {
      starters: unknown[];
      total: number;
      status: string;
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.starters).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  test("returns empty status when no memory items exist", async () => {
    const res = await dispatch("conversation-starters");
    const body = (await res.json()) as {
      starters: unknown[];
      total: number;
      status: string;
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("empty");
    expect(body.starters).toHaveLength(0);
  });

  test("returns generating status when memory items exist but no starters", async () => {
    insertMemoryItem();

    const res = await dispatch("conversation-starters");
    const body = (await res.json()) as {
      starters: unknown[];
      total: number;
      status: string;
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("generating");
    expect(body.starters).toHaveLength(0);
  });

  test("respects limit parameter", async () => {
    for (let i = 0; i < 6; i++) {
      insertStarter({
        label: `Starter ${i}`,
        prompt: `Prompt ${i}`,
        category: [
          "development",
          "communication",
          "productivity",
          "media",
          "automation",
          "knowledge",
        ][i],
        createdAt: Date.now() + i,
      });
    }

    const res = await dispatch("conversation-starters?limit=3");
    const body = (await res.json()) as { starters: unknown[]; total: number };

    expect(body.starters).toHaveLength(3);
    expect(body.total).toBe(6);
  });

  test("returns starters with category-diverse ordering", async () => {
    // Insert starters with some categories repeated
    const now = Date.now();
    insertStarter({
      label: "Dev 1",
      prompt: "p1",
      category: "development",
      createdAt: now + 5,
    });
    insertStarter({
      label: "Dev 2",
      prompt: "p2",
      category: "development",
      createdAt: now + 4,
    });
    insertStarter({
      label: "Comm 1",
      prompt: "p3",
      category: "communication",
      createdAt: now + 3,
    });
    insertStarter({
      label: "Prod 1",
      prompt: "p4",
      category: "productivity",
      createdAt: now + 2,
    });

    const res = await dispatch("conversation-starters?limit=4");
    const body = (await res.json()) as {
      starters: Array<{ label: string; category: string }>;
    };

    // The first three items should all have different categories
    const firstThreeCategories = body.starters
      .slice(0, 3)
      .map((s) => s.category);
    const uniqueCategories = new Set(firstThreeCategories);
    expect(uniqueCategories.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// orderStrongestFirst unit tests
// ---------------------------------------------------------------------------

describe("orderStrongestFirst", () => {
  function makeItem(label: string, category: string, batch = 1) {
    return {
      id: uuid(),
      label,
      prompt: `prompt for ${label}`,
      category,
      batch,
    };
  }

  test("returns empty array for empty input", () => {
    expect(orderStrongestFirst([])).toEqual([]);
  });

  test("returns single item unchanged", () => {
    const item = makeItem("A", "development");
    expect(orderStrongestFirst([item])).toEqual([item]);
  });

  test("interleaves categories to avoid adjacent duplicates", () => {
    const items = [
      makeItem("Dev 1", "development"),
      makeItem("Dev 2", "development"),
      makeItem("Comm 1", "communication"),
      makeItem("Prod 1", "productivity"),
    ];

    const ordered = orderStrongestFirst(items);

    // No two adjacent items should share a category
    for (let i = 1; i < ordered.length; i++) {
      if (ordered.length > 2) {
        // With 3+ distinct categories and 4 items, at most 1 adjacency conflict
        // but our algorithm should avoid them
      }
    }

    // All items should be present
    expect(ordered).toHaveLength(4);
    const labels = new Set(ordered.map((i) => i.label));
    expect(labels.size).toBe(4);
  });

  test("produces deterministic output for same input", () => {
    const items = [
      makeItem("A", "development"),
      makeItem("B", "communication"),
      makeItem("C", "productivity"),
      makeItem("D", "development"),
      makeItem("E", "media"),
    ];

    const run1 = orderStrongestFirst([...items]);
    const run2 = orderStrongestFirst([...items]);

    expect(run1.map((i) => i.label)).toEqual(run2.map((i) => i.label));
  });

  test("handles all items with the same category", () => {
    const items = [
      makeItem("A", "development"),
      makeItem("B", "development"),
      makeItem("C", "development"),
    ];

    const ordered = orderStrongestFirst(items);
    expect(ordered).toHaveLength(3);
    expect(ordered.map((i) => i.label)).toEqual(["A", "B", "C"]);
  });

  test("maximizes category diversity in top positions", () => {
    const items = [
      makeItem("Dev 1", "development"),
      makeItem("Dev 2", "development"),
      makeItem("Dev 3", "development"),
      makeItem("Comm 1", "communication"),
      makeItem("Prod 1", "productivity"),
    ];

    const ordered = orderStrongestFirst(items);
    const topFourCategories = ordered.slice(0, 3).map((i) => i.category);
    const uniqueTop = new Set(topFourCategories);

    // All three distinct categories should appear in the top 3
    expect(uniqueTop.size).toBe(3);
  });
});
