/**
 * Round-trip tests for the three inference-profile session IPC ops:
 * inference_profile_open, inference_profile_close, inference_profile_list.
 *
 * These tests exercise the route handler functions (the IPC-facing entry
 * points) rather than the shared helper directly.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

mock.module("../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: { publish: async () => {} },
}));

mock.module("../runtime/assistant-event.js", () => ({
  buildAssistantEvent: (event: unknown) => event,
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({
    llm: {
      profiles: { balanced: {}, "cost-optimized": {} },
      profileSession: { defaultTtlSeconds: 1800, maxTtlSeconds: 43200 },
    },
  }),
  getConfig: () => ({
    llm: {
      profiles: { balanced: {}, "cost-optimized": {} },
      profileSession: { defaultTtlSeconds: 1800, maxTtlSeconds: 43200 },
    },
  }),
}));

import { createConversation } from "../memory/conversation-crud.js";
import { getDb, resetDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { ROUTES } from "../runtime/routes/inference-profile-session-routes.js";

initializeDb();

const openRoute = ROUTES.find((r) => r.operationId === "inference_profile_open")!;
const closeRoute = ROUTES.find((r) => r.operationId === "inference_profile_close")!;
const listRoute = ROUTES.find((r) => r.operationId === "inference_profile_list")!;

function clearTables(): void {
  const db = getDb();
  db.run("DELETE FROM conversation_assistant_attention_state");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

describe("inference_profile_open IPC op", () => {
  beforeEach(clearTables);
  afterAll(() => {
    resetDb();
    mock.restore();
  });

  test("opens a session with TTL and returns sessionId + expiresAt", async () => {
    const conv = createConversation("ipc-open-ttl");

    const result = await openRoute.handler({
      body: { conversationId: conv.id, profile: "balanced", ttlSeconds: 300 },
      headers: {},
    });

    expect(result).toMatchObject({
      conversationId: conv.id,
      profile: "balanced",
      replaced: null,
    });
    expect((result as { sessionId: string }).sessionId).not.toBeNull();
    expect((result as { expiresAt: number }).expiresAt).toBeGreaterThan(Date.now());
  });

  test("opens a sticky session (no ttlSeconds) — sessionId=null, expiresAt=null", async () => {
    const conv = createConversation("ipc-open-sticky");

    const result = await openRoute.handler({
      body: { conversationId: conv.id, profile: "balanced" },
      headers: {},
    });

    expect(result).toMatchObject({
      conversationId: conv.id,
      profile: "balanced",
      sessionId: null,
      expiresAt: null,
      replaced: null,
    });
  });

  test("rejects profile=null with BadRequestError", async () => {
    const conv = createConversation("ipc-open-null-profile");

    await expect(
      openRoute.handler({
        body: { conversationId: conv.id, profile: null },
        headers: {},
      }),
    ).rejects.toThrow("profile must be a non-empty string");
  });

  test("replaced carries prior session when opening over an active session", async () => {
    const conv = createConversation("ipc-open-replace");

    const first = (await openRoute.handler({
      body: { conversationId: conv.id, profile: "balanced", ttlSeconds: 300 },
      headers: {},
    })) as { sessionId: string };

    const second = (await openRoute.handler({
      body: {
        conversationId: conv.id,
        profile: "cost-optimized",
        ttlSeconds: 600,
      },
      headers: {},
    })) as { replaced: { profile: string; sessionId: string } | null };

    expect(second.replaced).not.toBeNull();
    expect(second.replaced!.profile).toBe("balanced");
    expect(second.replaced!.sessionId).toBe(first.sessionId);
  });
});

describe("inference_profile_close IPC op", () => {
  beforeEach(clearTables);

  test("closes an active session — noop=false, closed carries profile and sessionId", async () => {
    const conv = createConversation("ipc-close-active");

    const opened = (await openRoute.handler({
      body: { conversationId: conv.id, profile: "balanced", ttlSeconds: 300 },
      headers: {},
    })) as { sessionId: string };

    const result = (await closeRoute.handler({
      body: { conversationId: conv.id },
      headers: {},
    })) as { noop: boolean; closed: { profile: string; sessionId: string } | null };

    expect(result.noop).toBe(false);
    expect(result.closed).not.toBeNull();
    expect(result.closed!.profile).toBe("balanced");
    expect(result.closed!.sessionId).toBe(opened.sessionId);
  });

  test("close with no active session — noop=true, closed=null", async () => {
    const conv = createConversation("ipc-close-noop");

    const result = (await closeRoute.handler({
      body: { conversationId: conv.id },
      headers: {},
    })) as { noop: boolean; closed: null };

    expect(result.noop).toBe(true);
    expect(result.closed).toBeNull();
  });
});

describe("inference_profile_list IPC op", () => {
  beforeEach(clearTables);

  test("lists active sessions across all conversations when no filter", async () => {
    const conv1 = createConversation("ipc-list-all-1");
    const conv2 = createConversation("ipc-list-all-2");

    await openRoute.handler({
      body: { conversationId: conv1.id, profile: "balanced", ttlSeconds: 300 },
      headers: {},
    });
    await openRoute.handler({
      body: {
        conversationId: conv2.id,
        profile: "cost-optimized",
        ttlSeconds: 600,
      },
      headers: {},
    });

    const result = (await listRoute.handler({
      queryParams: {},
      headers: {},
    })) as { sessions: Array<{ conversationId: string }> };

    expect(result.sessions.length).toBeGreaterThanOrEqual(2);
    const ids = result.sessions.map((s) => s.conversationId);
    expect(ids).toContain(conv1.id);
    expect(ids).toContain(conv2.id);
  });

  test("scopes to a single conversation when conversationId filter is provided", async () => {
    const conv1 = createConversation("ipc-list-filter-1");
    const conv2 = createConversation("ipc-list-filter-2");

    await openRoute.handler({
      body: { conversationId: conv1.id, profile: "balanced", ttlSeconds: 300 },
      headers: {},
    });
    await openRoute.handler({
      body: {
        conversationId: conv2.id,
        profile: "cost-optimized",
        ttlSeconds: 600,
      },
      headers: {},
    });

    const result = (await listRoute.handler({
      queryParams: { conversationId: conv1.id },
      headers: {},
    })) as { sessions: Array<{ conversationId: string }> };

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].conversationId).toBe(conv1.id);
  });

  test("returns empty list when no active session for the given conversationId", async () => {
    const conv = createConversation("ipc-list-empty");

    const result = (await listRoute.handler({
      queryParams: { conversationId: conv.id },
      headers: {},
    })) as { sessions: unknown[] };

    expect(result.sessions).toHaveLength(0);
  });
});
