/**
 * Unit tests for the `/v1/home/feed` HTTP route handlers.
 *
 * These tests drive the handler functions directly (bypassing the
 * router) so they exercise the handler logic — validation, filtering,
 * 404 vs 500 distinction, and context-banner computation — without
 * needing a live HTTP server.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Module mocks ──────────────────────────────────────────────────────────
// Stub the assistantEventHub so the feed writer's SSE publish does not
// reach into the real hub (which can pull in platform services we
// don't want to boot in a unit test).
const publishSpy = mock<(event: unknown) => Promise<void>>(async () => {});
mock.module("../../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: publishSpy,
    subscribe: () => () => {},
  },
}));

// Stub conversation CRUD so we don't spin up a real sqlite DB.
const createdConversations: Array<{ id: string; title?: string | null }> = [];
const addedMessages: Array<{
  conversationId: string;
  role: string;
  content: string;
}> = [];
let createConversationShouldThrow = false;

mock.module("../../../memory/conversation-crud.js", () => ({
  createConversation: (opts: unknown) => {
    if (createConversationShouldThrow) {
      throw new Error("synthetic createConversation failure");
    }
    const title =
      typeof opts === "string"
        ? opts
        : ((opts as { title?: string } | undefined)?.title ?? null);
    const id = `conv-${createdConversations.length + 1}`;
    const conv = { id, title };
    createdConversations.push(conv);
    return conv;
  },
  addMessage: async (conversationId: string, role: string, content: string) => {
    addedMessages.push({ conversationId, role, content });
    return { id: `msg-${addedMessages.length}` };
  },
}));

// Dynamic imports so module mocks are wired before evaluation.
const {
  computeGreeting,
  formatRelativeTime,
  handleGetHomeFeed,
  handlePatchFeedItem,
  handlePostFeedAction,
  homeFeedRouteDefinitions,
} = await import("../home-feed-routes.js");
const { appendFeedItem, getHomeFeedPath } =
  await import("../../../home/feed-writer.js");

// ─── Fixtures ──────────────────────────────────────────────────────────────

type FeedItemFixture = {
  id: string;
  type: "nudge" | "digest" | "action" | "thread";
  priority: number;
  title: string;
  summary: string;
  source?: "gmail" | "slack" | "calendar" | "assistant";
  timestamp: string;
  status: "new" | "seen" | "acted_on";
  expiresAt?: string;
  minTimeAway?: number;
  actions?: Array<{ id: string; label: string; prompt: string }>;
  author: "assistant" | "platform";
  createdAt: string;
};

function makeItem(
  overrides: Partial<FeedItemFixture> & { id: string },
): FeedItemFixture {
  return {
    type: "nudge",
    priority: 50,
    title: "Test",
    summary: "Test summary",
    timestamp: "2026-04-14T12:00:00.000Z",
    status: "new",
    author: "platform",
    createdAt: "2026-04-14T12:00:00.000Z",
    ...overrides,
  };
}

function writeFeedFile(items: FeedItemFixture[]): void {
  const path = getHomeFeedPath();
  mkdirSync(join(workspaceDir, "data"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-04-14T12:00:00.000Z",
        items,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-hfr-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  publishSpy.mockClear();
  createdConversations.length = 0;
  addedMessages.length = 0;
  createConversationShouldThrow = false;
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ─── Pure helpers ──────────────────────────────────────────────────────────

describe("computeGreeting", () => {
  test("morning (5-11)", () => {
    expect(computeGreeting(new Date(2026, 3, 14, 5, 0, 0))).toBe(
      "Good morning",
    );
    expect(computeGreeting(new Date(2026, 3, 14, 11, 59, 59))).toBe(
      "Good morning",
    );
  });

  test("afternoon (12-16)", () => {
    expect(computeGreeting(new Date(2026, 3, 14, 12, 0, 0))).toBe(
      "Good afternoon",
    );
    expect(computeGreeting(new Date(2026, 3, 14, 16, 59, 59))).toBe(
      "Good afternoon",
    );
  });

  test("evening (17-21)", () => {
    expect(computeGreeting(new Date(2026, 3, 14, 17, 0, 0))).toBe(
      "Good evening",
    );
    expect(computeGreeting(new Date(2026, 3, 14, 21, 59, 59))).toBe(
      "Good evening",
    );
  });

  test("late-night / early-morning fallback (Welcome back)", () => {
    expect(computeGreeting(new Date(2026, 3, 14, 22, 0, 0))).toBe(
      "Welcome back",
    );
    expect(computeGreeting(new Date(2026, 3, 14, 2, 0, 0))).toBe(
      "Welcome back",
    );
    expect(computeGreeting(new Date(2026, 3, 14, 4, 59, 59))).toBe(
      "Welcome back",
    );
  });
});

describe("formatRelativeTime", () => {
  test("under a minute", () => {
    expect(formatRelativeTime(0)).toBe("just now");
    expect(formatRelativeTime(30)).toBe("just now");
    expect(formatRelativeTime(59)).toBe("just now");
  });

  test("minutes", () => {
    expect(formatRelativeTime(60)).toBe("1 minute ago");
    expect(formatRelativeTime(120)).toBe("2 minutes ago");
    expect(formatRelativeTime(3599)).toBe("59 minutes ago");
  });

  test("hours", () => {
    expect(formatRelativeTime(3600)).toBe("1 hour ago");
    expect(formatRelativeTime(7200)).toBe("2 hours ago");
  });

  test("yesterday", () => {
    expect(formatRelativeTime(86400)).toBe("yesterday");
    expect(formatRelativeTime(100000)).toBe("yesterday");
  });

  test("multiple days", () => {
    expect(formatRelativeTime(172800)).toBe("2 days ago");
    expect(formatRelativeTime(345600)).toBe("4 days ago");
  });
});

// ─── Route registration ────────────────────────────────────────────────────

describe("homeFeedRouteDefinitions", () => {
  test("registers GET /v1/home/feed, PATCH /v1/home/feed/:id, and POST /v1/home/feed/:id/actions/:actionId", () => {
    const routes = homeFeedRouteDefinitions();
    const endpoints = routes.map((r) => `${r.method} ${r.endpoint}`);
    expect(endpoints).toContain("GET home/feed");
    expect(endpoints).toContain("PATCH home/feed/:id");
    expect(endpoints).toContain("POST home/feed/:id/actions/:actionId");
  });
});

// ─── handleGetHomeFeed ─────────────────────────────────────────────────────

describe("handleGetHomeFeed", () => {
  test("400 when timeAwaySeconds is missing", async () => {
    const res = await handleGetHomeFeed(
      new Request("http://localhost/v1/home/feed"),
    );
    expect(res.status).toBe(400);
  });

  test("400 when timeAwaySeconds is negative", async () => {
    const res = await handleGetHomeFeed(
      new Request("http://localhost/v1/home/feed?timeAwaySeconds=-5"),
    );
    expect(res.status).toBe(400);
  });

  test("400 when timeAwaySeconds is non-integer", async () => {
    const res = await handleGetHomeFeed(
      new Request("http://localhost/v1/home/feed?timeAwaySeconds=3.14"),
    );
    expect(res.status).toBe(400);
  });

  test("empty feed returns empty items and zero newCount", async () => {
    const res = await handleGetHomeFeed(
      new Request("http://localhost/v1/home/feed?timeAwaySeconds=0"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      updatedAt: string;
      contextBanner: {
        greeting: string;
        timeAwayLabel: string;
        newCount: number;
      };
    };
    expect(body.items).toEqual([]);
    expect(typeof body.updatedAt).toBe("string");
    expect(body.contextBanner.newCount).toBe(0);
    expect(body.contextBanner.timeAwayLabel).toBe("just now");
    expect(typeof body.contextBanner.greeting).toBe("string");
  });

  test("filters out items whose minTimeAway exceeds timeAwaySeconds", async () => {
    writeFeedFile([
      makeItem({
        id: "gated",
        type: "nudge",
        minTimeAway: 3600,
      }),
      makeItem({
        id: "ungated",
        type: "nudge",
      }),
    ]);

    const res = await handleGetHomeFeed(
      new Request("http://localhost/v1/home/feed?timeAwaySeconds=60"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string }>;
      contextBanner: { newCount: number };
    };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain("ungated");
    expect(ids).not.toContain("gated");
    expect(body.contextBanner.newCount).toBe(1);
  });

  test("includes items when timeAwaySeconds >= minTimeAway", async () => {
    writeFeedFile([
      makeItem({
        id: "gated",
        type: "nudge",
        minTimeAway: 3600,
      }),
    ]);

    const res = await handleGetHomeFeed(
      new Request("http://localhost/v1/home/feed?timeAwaySeconds=7200"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string }>;
      contextBanner: { newCount: number; timeAwayLabel: string };
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe("gated");
    expect(body.contextBanner.newCount).toBe(1);
    expect(body.contextBanner.timeAwayLabel).toBe("2 hours ago");
  });

  test("newCount counts only status=new after filtering", async () => {
    writeFeedFile([
      makeItem({ id: "a", status: "new" }),
      makeItem({ id: "b", status: "seen" }),
      makeItem({ id: "c", status: "acted_on" }),
      makeItem({ id: "d", status: "new" }),
    ]);

    const res = await handleGetHomeFeed(
      new Request("http://localhost/v1/home/feed?timeAwaySeconds=0"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contextBanner: { newCount: number };
    };
    expect(body.contextBanner.newCount).toBe(2);
  });
});

// ─── handlePatchFeedItem ───────────────────────────────────────────────────

describe("handlePatchFeedItem", () => {
  test("200 with updated item when id exists", async () => {
    await appendFeedItem(makeItem({ id: "p1", status: "new" }) as never);

    const res = await handlePatchFeedItem(
      new Request("http://localhost/v1/home/feed/p1", {
        method: "PATCH",
        body: JSON.stringify({ status: "seen" }),
      }),
      "p1",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe("p1");
    expect(body.status).toBe("seen");
  });

  test("404 when id does not exist", async () => {
    const res = await handlePatchFeedItem(
      new Request("http://localhost/v1/home/feed/missing", {
        method: "PATCH",
        body: JSON.stringify({ status: "seen" }),
      }),
      "missing",
    );
    expect(res.status).toBe(404);
  });

  test("400 on invalid status value", async () => {
    await appendFeedItem(makeItem({ id: "p2", status: "new" }) as never);

    const res = await handlePatchFeedItem(
      new Request("http://localhost/v1/home/feed/p2", {
        method: "PATCH",
        body: JSON.stringify({ status: "bogus" }),
      }),
      "p2",
    );
    expect(res.status).toBe(400);
  });

  test("400 on missing status field", async () => {
    await appendFeedItem(makeItem({ id: "p3", status: "new" }) as never);

    const res = await handlePatchFeedItem(
      new Request("http://localhost/v1/home/feed/p3", {
        method: "PATCH",
        body: JSON.stringify({}),
      }),
      "p3",
    );
    expect(res.status).toBe(400);
  });

  test("400 on invalid JSON body", async () => {
    await appendFeedItem(makeItem({ id: "p4", status: "new" }) as never);

    const res = await handlePatchFeedItem(
      new Request("http://localhost/v1/home/feed/p4", {
        method: "PATCH",
        body: "not json",
      }),
      "p4",
    );
    expect(res.status).toBe(400);
  });
});

// ─── handlePostFeedAction ──────────────────────────────────────────────────

describe("handlePostFeedAction", () => {
  test("creates a conversation pre-seeded with the action prompt", async () => {
    writeFeedFile([
      makeItem({
        id: "item-1",
        type: "action",
        actions: [
          {
            id: "reply",
            label: "Reply",
            prompt: "Draft a reply to this email",
          },
        ],
      }),
    ]);

    const res = await handlePostFeedAction(
      new Request("http://localhost/v1/home/feed/item-1/actions/reply", {
        method: "POST",
      }),
      "item-1",
      "reply",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversationId: string };
    expect(body.conversationId).toBe("conv-1");

    expect(createdConversations).toHaveLength(1);
    expect(createdConversations[0]!.title).toBe("Reply");

    expect(addedMessages).toHaveLength(1);
    expect(addedMessages[0]!.role).toBe("user");
    expect(addedMessages[0]!.conversationId).toBe("conv-1");
    const content = JSON.parse(addedMessages[0]!.content) as Array<{
      type: string;
      text: string;
    }>;
    expect(content[0]!.text).toBe("Draft a reply to this email");
  });

  test("404 when the item does not exist", async () => {
    const res = await handlePostFeedAction(
      new Request("http://localhost/v1/home/feed/nope/actions/reply", {
        method: "POST",
      }),
      "nope",
      "reply",
    );
    expect(res.status).toBe(404);
    expect(createdConversations).toHaveLength(0);
  });

  test("404 when the action id is unknown on a real item", async () => {
    writeFeedFile([
      makeItem({
        id: "item-2",
        type: "action",
        actions: [{ id: "reply", label: "Reply", prompt: "hi" }],
      }),
    ]);

    const res = await handlePostFeedAction(
      new Request("http://localhost/v1/home/feed/item-2/actions/archive", {
        method: "POST",
      }),
      "item-2",
      "archive",
    );
    expect(res.status).toBe(404);
    expect(createdConversations).toHaveLength(0);
  });

  test("500 when createConversation throws", async () => {
    writeFeedFile([
      makeItem({
        id: "item-3",
        type: "action",
        actions: [{ id: "reply", label: "Reply", prompt: "hi" }],
      }),
    ]);
    createConversationShouldThrow = true;

    const res = await handlePostFeedAction(
      new Request("http://localhost/v1/home/feed/item-3/actions/reply", {
        method: "POST",
      }),
      "item-3",
      "reply",
    );
    expect(res.status).toBe(500);
  });
});
