import { beforeEach, describe, expect, mock, test } from "bun:test";

import { v4 as uuid } from "uuid";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getSqlite, initializeDb } from "../memory/db.js";
import {
  conversationStarterRouteDefinitions,
  orderStrongestFirst,
} from "../runtime/routes/conversation-starter-routes.js";

initializeDb();

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
    [
      uuid(),
      overrides.label,
      overrides.prompt,
      overrides.category,
      overrides.batch ?? 1,
      overrides.scopeId ?? "default",
      overrides.createdAt ?? now,
    ],
  );
}

function insertMemoryItem(scopeId = "default") {
  const now = Date.now();
  getSqlite().run(
    `INSERT INTO memory_items (
      id, kind, subject, statement, status, confidence, fingerprint, scope_id, first_seen_at, last_seen_at
    ) VALUES (?, 'fact', 'test', 'test statement', 'active', 0.9, ?, ?, ?, ?)`,
    [uuid(), `fingerprint-${uuid()}`, scopeId, now, now],
  );
}

beforeEach(() => {
  clearTables();
});

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
        ][i]!,
        createdAt: Date.now() + i,
      });
    }

    const res = await dispatch("conversation-starters?limit=3");
    const body = (await res.json()) as { starters: unknown[]; total: number };

    expect(body.starters).toHaveLength(3);
    expect(body.total).toBe(6);
  });

  test("surfaces category-diverse starters first", async () => {
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

    const firstThreeCategories = body.starters
      .slice(0, 3)
      .map((starter) => starter.category);
    expect(new Set(firstThreeCategories).size).toBe(3);
  });
});

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

  test("produces deterministic output for the same input", () => {
    const items = [
      makeItem("A", "development"),
      makeItem("B", "communication"),
      makeItem("C", "productivity"),
      makeItem("D", "development"),
      makeItem("E", "media"),
    ];

    const run1 = orderStrongestFirst([...items]);
    const run2 = orderStrongestFirst([...items]);

    expect(run1.map((item) => item.label)).toEqual(
      run2.map((item) => item.label),
    );
  });

  test("preserves order when every item shares a category", () => {
    const items = [
      makeItem("A", "development"),
      makeItem("B", "development"),
      makeItem("C", "development"),
    ];

    expect(orderStrongestFirst(items).map((item) => item.label)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  test("maximizes early category diversity when alternatives exist", () => {
    const items = [
      makeItem("Dev 1", "development"),
      makeItem("Dev 2", "development"),
      makeItem("Dev 3", "development"),
      makeItem("Comm 1", "communication"),
      makeItem("Prod 1", "productivity"),
    ];

    const ordered = orderStrongestFirst(items);
    const topThreeCategories = ordered.slice(0, 3).map((item) => item.category);
    expect(new Set(topThreeCategories).size).toBe(3);
  });
});
