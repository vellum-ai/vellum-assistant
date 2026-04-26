import { beforeEach, describe, expect, mock, test } from "bun:test";

import { v4 as uuid } from "uuid";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../prompts/user-reference.js", () => ({
  DEFAULT_USER_REFERENCE: "my human",
  resolveUserReference: () => "Alice",
}));

import { getSqlite, initializeDb } from "../memory/db.js";
import type { RouteParams } from "../runtime/http-router.js";
import {
  CONVERSATION_STARTERS_STALE_TTL_MS,
  conversationStarterRouteDefinitions,
  orderStrongestFirst,
} from "../runtime/routes/conversation-starter-routes.js";

initializeDb();

const routes = conversationStarterRouteDefinitions();

function dispatch(path: string, method = "GET"): Response | Promise<Response> {
  const url = new URL(`http://localhost/v1/${path}`);
  const req = new Request(url.toString(), { method });
  const route = routes.find(
    (r) =>
      r.method === method &&
      (r.endpoint === "conversation-starters" ||
        r.endpoint === "conversation-starters/:id"),
  );
  if (!route) throw new Error("No conversation-starters route found");
  const params: RouteParams =
    method === "DELETE"
      ? { id: decodeURIComponent(path.split("/").at(-1) ?? "") }
      : {};
  return route.handler({
    req,
    url,
    server: null as never,
    authContext: {} as never,
    params,
  });
}

function clearTables() {
  getSqlite().run("DELETE FROM conversation_starters");
  getSqlite().run("DELETE FROM memory_graph_nodes");
  getSqlite().run("DELETE FROM memory_jobs");
  getSqlite().run("DELETE FROM memory_checkpoints");
}

function insertStarter(overrides: {
  id?: string;
  label: string;
  prompt: string;
  category: string;
  batch?: number;
  scopeId?: string;
  createdAt?: number;
}) {
  const now = Date.now();
  const id = overrides.id ?? uuid();
  getSqlite().run(
    `INSERT INTO conversation_starters (id, label, prompt, category, generation_batch, scope_id, card_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'chip', ?)`,
    [
      id,
      overrides.label,
      overrides.prompt,
      overrides.category,
      overrides.batch ?? 1,
      overrides.scopeId ?? "default",
      overrides.createdAt ?? now,
    ],
  );
  return id;
}

function insertMemoryItem(scopeId = "default") {
  const now = Date.now();
  getSqlite().run(
    `INSERT INTO memory_graph_nodes (
      id, content, type, created, last_accessed, last_consolidated,
      emotional_charge, fidelity, confidence, significance,
      stability, reinforcement_count, last_reinforced,
      source_conversations, source_type, scope_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'vivid', 0.8, 0.5, 14, 0, ?, '[]', 'inferred', ?)`,
    [
      uuid(),
      "test\ntest statement",
      "semantic",
      now,
      now,
      now,
      '{"valence":0,"intensity":0.1,"decayCurve":"linear","decayRate":0.05,"originalIntensity":0.1}',
      now,
      scopeId,
    ],
  );
}

function setCheckpoint(key: string, value: string, updatedAt = Date.now()) {
  getSqlite().run(
    `INSERT OR REPLACE INTO memory_checkpoints (key, value, updated_at) VALUES (?, ?, ?)`,
    [key, value, updatedAt],
  );
}

function insertStarterJob(scopeId = "default", status = "pending") {
  const now = Date.now();
  getSqlite().run(
    `INSERT INTO memory_jobs (
      id, type, payload, status, attempts, deferrals, run_after, last_error,
      started_at, created_at, updated_at
    ) VALUES (?, 'generate_conversation_starters', ?, ?, 0, 0, ?, NULL, NULL, ?, ?)`,
    [uuid(), JSON.stringify({ scopeId }), status, now, now, now],
  );
}

function countStarterJobs() {
  return (
    getSqlite()
      .prepare(
        `SELECT COUNT(*) AS c FROM memory_jobs WHERE type = 'generate_conversation_starters'`,
      )
      .get() as { c: number }
  ).c;
}

beforeEach(() => {
  clearTables();
});

describe("GET /v1/conversation-starters", () => {
  test("returns ready status with starters when they exist", async () => {
    const now = Date.now();
    insertStarter({
      label: "Draft a PR summary",
      prompt: "Draft a summary for my latest PR",
      category: "development",
      createdAt: now,
    });
    insertStarter({
      label: "Check Slack threads",
      prompt: "Check my unread Slack threads",
      category: "communication",
      createdAt: now,
    });
    setCheckpoint("conversation_starters:last_gen_at:default", String(now));
    setCheckpoint("conversation_starters:item_count_at_last_gen:default", "2");
    insertMemoryItem();
    insertMemoryItem();

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

  test("returns refreshing with existing starters when the batch is stale and enqueues one refresh job", async () => {
    const now = Date.now();
    insertStarter({
      label: "Draft a PR summary",
      prompt: "Draft a summary for my latest PR",
      category: "development",
      createdAt: now - 1_000,
    });
    insertStarter({
      label: "Check Slack threads",
      prompt: "Check my unread Slack threads",
      category: "communication",
      createdAt: now - 2_000,
    });
    setCheckpoint(
      "conversation_starters:last_gen_at:default",
      String(now - CONVERSATION_STARTERS_STALE_TTL_MS - 1_000),
    );
    setCheckpoint("conversation_starters:item_count_at_last_gen:default", "2");
    insertMemoryItem();
    insertMemoryItem();

    const res = await dispatch("conversation-starters");
    const body = (await res.json()) as {
      starters: unknown[];
      total: number;
      status: string;
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("refreshing");
    expect(body.starters).toHaveLength(2);
    expect(countStarterJobs()).toBe(1);
  });

  test("returns refreshing with existing starters when the checkpoint count is ahead of active memory and enqueues one refresh job", async () => {
    const now = Date.now();
    insertStarter({
      label: "Draft a PR summary",
      prompt: "Draft a summary for my latest PR",
      category: "development",
      createdAt: now,
    });
    setCheckpoint("conversation_starters:last_gen_at:default", String(now));
    setCheckpoint("conversation_starters:item_count_at_last_gen:default", "5");
    insertMemoryItem();
    insertMemoryItem();

    const res = await dispatch("conversation-starters");
    const body = (await res.json()) as {
      starters: unknown[];
      total: number;
      status: string;
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("refreshing");
    expect(body.starters).toHaveLength(1);
    expect(countStarterJobs()).toBe(1);
  });

  test("does not enqueue duplicate refresh jobs when a starter job is already active", async () => {
    const now = Date.now();
    insertStarter({
      label: "Draft a PR summary",
      prompt: "Draft a summary for my latest PR",
      category: "development",
      createdAt: now,
    });
    setCheckpoint(
      "conversation_starters:last_gen_at:default",
      String(now - CONVERSATION_STARTERS_STALE_TTL_MS - 1_000),
    );
    setCheckpoint("conversation_starters:item_count_at_last_gen:default", "1");
    insertMemoryItem();
    insertStarterJob("default");

    const res = await dispatch("conversation-starters");
    const body = (await res.json()) as {
      starters: unknown[];
      total: number;
      status: string;
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("refreshing");
    expect(body.starters).toHaveLength(1);
    expect(countStarterJobs()).toBe(1);
  });

  test("filters assistant-voice starters and refreshes the batch", async () => {
    const now = Date.now();
    insertStarter({
      label: "Let me check calendar",
      prompt: "Let me check what Alice has today.",
      category: "productivity",
      createdAt: now,
    });
    insertStarter({
      label: "Plan my morning",
      prompt: "Can you help me plan my morning?",
      category: "productivity",
      createdAt: now - 1,
    });
    setCheckpoint("conversation_starters:last_gen_at:default", String(now));
    setCheckpoint("conversation_starters:item_count_at_last_gen:default", "1");
    insertMemoryItem();

    const res = await dispatch("conversation-starters");
    const body = (await res.json()) as {
      starters: Array<{ label: string }>;
      total: number;
      status: string;
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("refreshing");
    expect(body.total).toBe(1);
    expect(body.starters.map((starter) => starter.label)).toEqual([
      "Plan my morning",
    ]);
    expect(countStarterJobs()).toBe(1);
  });

  test("filters current-user third-person starters", async () => {
    const now = Date.now();
    insertStarter({
      label: "Catch up with Alice",
      prompt: "What has Alice been thinking about today?",
      category: "communication",
      createdAt: now,
    });
    insertStarter({
      label: "Catch me up",
      prompt: "Can you catch me up on what you've been thinking about today?",
      category: "communication",
      createdAt: now - 1,
    });
    setCheckpoint("conversation_starters:last_gen_at:default", String(now));
    setCheckpoint("conversation_starters:item_count_at_last_gen:default", "1");
    insertMemoryItem();

    const res = await dispatch("conversation-starters");
    const body = (await res.json()) as {
      starters: Array<{ label: string }>;
      total: number;
      status: string;
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("refreshing");
    expect(body.total).toBe(1);
    expect(body.starters.map((starter) => starter.label)).toEqual([
      "Catch me up",
    ]);
    expect(countStarterJobs()).toBe(1);
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

  test("deletes a starter and excludes it from subsequent list responses", async () => {
    const deletedId = insertStarter({
      label: "Draft a PR summary",
      prompt: "Draft a summary for my latest PR",
      category: "development",
    });
    const keptId = insertStarter({
      label: "Check Slack threads",
      prompt: "Check my unread Slack threads",
      category: "communication",
    });

    const deleteRes = await dispatch(
      `conversation-starters/${deletedId}`,
      "DELETE",
    );
    const deleteBody = (await deleteRes.json()) as {
      deleted: boolean;
      id: string;
    };
    expect(deleteRes.status).toBe(200);
    expect(deleteBody).toEqual({ deleted: true, id: deletedId });
    expect(countStarterJobs()).toBe(0);

    const listRes = await dispatch("conversation-starters");
    const listBody = (await listRes.json()) as {
      starters: Array<{ id: string }>;
      total: number;
    };
    expect(listBody.total).toBe(1);
    expect(listBody.starters.map((starter) => starter.id)).toEqual([keptId]);
  });

  test("returns 404 when deleting an unknown starter", async () => {
    const res = await dispatch(`conversation-starters/${uuid()}`, "DELETE");
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(countStarterJobs()).toBe(0);
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
