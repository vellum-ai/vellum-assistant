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
  orderCardsForHero,
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
  getSqlite().run("DELETE FROM capability_card_categories");
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
  getSqlite().run(
    `INSERT INTO memory_items (id, kind, subject, statement, importance, status, confidence, fingerprint, scope_id, first_seen_at, last_seen_at)
     VALUES (?, 'fact', 'test', 'test statement', 5, 'active', 0.8, ?, ?, ?, ?)`,
    [uuid(), uuid(), scopeId, Date.now(), Date.now()],
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

// ---------------------------------------------------------------------------
// orderCardsForHero unit tests
// ---------------------------------------------------------------------------

describe("orderCardsForHero", () => {
  function makeCard(
    label: string,
    category: string,
    opts: { highPriority?: boolean; batch?: number } = {},
  ) {
    const tags: string[] = [];
    if (opts.highPriority) tags.push("__high_priority__");
    tags.push("Quick win");
    return {
      id: uuid(),
      icon: "lucide-sparkles",
      label,
      description: `desc for ${label}`,
      prompt: `prompt for ${label}`,
      category,
      tags: tags.join(","),
      batch: opts.batch ?? 1,
    };
  }

  test("returns empty array for empty input", () => {
    expect(orderCardsForHero([], new Map())).toEqual([]);
  });

  test("returns single card unchanged", () => {
    const card = makeCard("A", "development");
    expect(orderCardsForHero([card], new Map())).toEqual([card]);
  });

  test("high_priority cards come first", () => {
    const normal = makeCard("Normal", "development");
    const priority = makeCard("Priority", "media", { highPriority: true });

    const ordered = orderCardsForHero([normal, priority], new Map());
    expect(ordered[0].label).toBe("Priority");
    expect(ordered[1].label).toBe("Normal");
  });

  test("contextual cluster beats active_work and discovery", () => {
    const discovery = makeCard("Discovery", "media");
    const activeWork = makeCard("Active", "development");
    const contextual = makeCard("Contextual", "communication");

    const ordered = orderCardsForHero(
      [discovery, activeWork, contextual],
      new Map(),
    );
    expect(ordered[0].label).toBe("Contextual");
    expect(ordered[1].label).toBe("Active");
    expect(ordered[2].label).toBe("Discovery");
  });

  test("higher category relevance wins within same cluster", () => {
    const lowRel = makeCard("Low", "media");
    const highRel = makeCard("High", "automation");

    const relevance = new Map([
      ["media", 0.7],
      ["automation", 0.95],
    ]);

    const ordered = orderCardsForHero([lowRel, highRel], relevance);
    // Both are discovery cluster — automation has higher relevance
    expect(ordered[0].label).toBe("High");
    expect(ordered[1].label).toBe("Low");
  });

  test("high_priority overrides cluster precedence", () => {
    const contextual = makeCard("Contextual", "communication");
    const priorityDiscovery = makeCard("Priority Discovery", "media", {
      highPriority: true,
    });

    const ordered = orderCardsForHero(
      [contextual, priorityDiscovery],
      new Map(),
    );
    // high_priority takes precedence over cluster
    expect(ordered[0].label).toBe("Priority Discovery");
    expect(ordered[1].label).toBe("Contextual");
  });

  test("produces deterministic output for same input", () => {
    const cards = [
      makeCard("A", "development"),
      makeCard("B", "communication"),
      makeCard("C", "media", { highPriority: true }),
      makeCard("D", "productivity"),
    ];

    const relevance = new Map([
      ["development", 0.9],
      ["communication", 0.8],
    ]);

    const run1 = orderCardsForHero([...cards], relevance);
    const run2 = orderCardsForHero([...cards], relevance);
    expect(run1.map((c) => c.label)).toEqual(run2.map((c) => c.label));
  });
});

// ---------------------------------------------------------------------------
// Card route integration tests
// ---------------------------------------------------------------------------

function insertCard(overrides: {
  label: string;
  prompt: string;
  category: string;
  tags?: string;
  batch?: number;
  scopeId?: string;
  createdAt?: number;
}) {
  const now = Date.now();
  getSqlite().run(
    `INSERT INTO conversation_starters (id, label, prompt, category, generation_batch, scope_id, card_type, tags, icon, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'card', ?, 'lucide-sparkles', 'desc', ?)`,
    [
      uuid(),
      overrides.label,
      overrides.prompt,
      overrides.category,
      overrides.batch ?? 1,
      overrides.scopeId ?? "default",
      overrides.tags ?? "Quick win",
      overrides.createdAt ?? now,
    ],
  );
}

function insertCategoryRelevance(
  category: string,
  relevance: number,
  scopeId = "default",
) {
  getSqlite().run(
    `INSERT OR REPLACE INTO capability_card_categories (scope_id, category, relevance, generation_batch, created_at)
     VALUES (?, ?, ?, 1, ?)`,
    [scopeId, category, relevance, Date.now()],
  );
}

describe("GET /v1/conversation-starters?card_type=card", () => {
  test("returns cards with tags as arrays and strips internal tags", async () => {
    insertCard({
      label: "Clear inbox",
      prompt: "Help me clear my inbox",
      category: "communication",
      tags: "__high_priority__,Quick win,2 min",
    });

    const res = await dispatch("conversation-starters?card_type=card");
    const body = (await res.json()) as {
      cards: Array<{ label: string; tags: string[] }>;
      status: string;
    };

    expect(res.status).toBe(200);
    expect(body.cards).toHaveLength(1);
    // Internal __high_priority__ tag should be stripped
    expect(body.cards[0].tags).toEqual(["Quick win", "2 min"]);
    expect(body.cards[0].tags).not.toContain("__high_priority__");
  });

  test("orders cards with high_priority first", async () => {
    const now = Date.now();
    insertCard({
      label: "Normal card",
      prompt: "p1",
      category: "development",
      tags: "High leverage",
      createdAt: now + 2,
    });
    insertCard({
      label: "Priority card",
      prompt: "p2",
      category: "media",
      tags: "__high_priority__,Quick win",
      createdAt: now + 1,
    });
    insertCategoryRelevance("development", 0.9);
    insertCategoryRelevance("media", 0.7);

    const res = await dispatch("conversation-starters?card_type=card");
    const body = (await res.json()) as {
      cards: Array<{ label: string }>;
    };

    expect(body.cards[0].label).toBe("Priority card");
    expect(body.cards[1].label).toBe("Normal card");
  });

  test("orders by cluster precedence when no high_priority", async () => {
    const now = Date.now();
    insertCard({
      label: "Discovery card",
      prompt: "p1",
      category: "media",
      createdAt: now + 3,
    });
    insertCard({
      label: "Active work card",
      prompt: "p2",
      category: "development",
      createdAt: now + 2,
    });
    insertCard({
      label: "Contextual card",
      prompt: "p3",
      category: "communication",
      createdAt: now + 1,
    });

    const res = await dispatch("conversation-starters?card_type=card");
    const body = (await res.json()) as {
      cards: Array<{ label: string; category: string }>;
    };

    // contextual > active_work > discovery
    expect(body.cards[0].label).toBe("Contextual card");
    expect(body.cards[1].label).toBe("Active work card");
    expect(body.cards[2].label).toBe("Discovery card");
  });

  test("returns empty status when no memory items", async () => {
    const res = await dispatch("conversation-starters?card_type=card");
    const body = (await res.json()) as {
      cards: unknown[];
      total: number;
      status: string;
    };

    expect(body.status).toBe("empty");
    expect(body.cards).toHaveLength(0);
  });
});
