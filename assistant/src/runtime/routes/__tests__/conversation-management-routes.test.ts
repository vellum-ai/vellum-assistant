/**
 * Tests for inference-profile route handlers.
 *
 * Exercises:
 *  - PUT /v1/conversations/:id/inference-profile (extended with ttlSeconds/sessionId)
 *  - POST /v1/conversations/inference-profile-session (inference_profile_open)
 *  - GET  /v1/conversations/inference-profile-sessions (inference_profile_list)
 *  - POST /v1/conversations/inference-profile-session/close (inference_profile_close)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Stub the event hub to avoid spinning up real SSE infrastructure.
mock.module("../../assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => () => {},
  },
}));

import { getDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import { conversations } from "../../../memory/schema.js";
import { ROUTES as CONVERSATION_MANAGEMENT_ROUTES } from "../conversation-management-routes.js";
import { ROUTES as INFERENCE_PROFILE_SESSION_ROUTES } from "../inference-profile-session-routes.js";
import type { RouteDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

initializeDb();

// ---------------------------------------------------------------------------
// Config fixture — must expose at least one profile so the handler can
// validate profile names.
// ---------------------------------------------------------------------------

let configLlmProfiles: Record<string, unknown> = {};

mock.module("../../../config/loader.js", () => ({
  loadConfig: () => ({
    llm: {
      profiles: configLlmProfiles,
      profileSession: { maxTtlSeconds: 43200 },
    },
  }),
  getConfig: () => ({
    llm: {
      profiles: configLlmProfiles,
      profileSession: { maxTtlSeconds: 43200 },
    },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findHandler(routes: RouteDefinition[], operationId: string) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

const putHandler = findHandler(
  CONVERSATION_MANAGEMENT_ROUTES,
  "setConversationInferenceProfile",
);
const openHandler = findHandler(
  INFERENCE_PROFILE_SESSION_ROUTES,
  "inference_profile_open",
);
const listHandler = findHandler(
  INFERENCE_PROFILE_SESSION_ROUTES,
  "inference_profile_list",
);
const closeHandler = findHandler(
  INFERENCE_PROFILE_SESSION_ROUTES,
  "inference_profile_close",
);

function clearConversations(): void {
  getDb().delete(conversations).run();
}

function seedConversation(id: string): void {
  const now = Date.now();
  getDb()
    .insert(conversations)
    .values({
      id,
      title: "Test conversation",
      createdAt: now,
      updatedAt: now,
      source: "test",
      conversationType: "standard",
      memoryScopeId: "default",
    })
    .run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PUT /v1/conversations/:id/inference-profile", () => {
  beforeEach(() => {
    clearConversations();
    configLlmProfiles = { fast: { model: "model-a" }, slow: { model: "model-b" } };
  });

  test("PUT with ttlSeconds=600 → response includes sessionId (UUID), expiresAt, ttlSeconds=600", async () => {
    const convId = crypto.randomUUID();
    seedConversation(convId);

    const result = (await putHandler({
      pathParams: { id: convId },
      body: { profile: "fast", ttlSeconds: 600 },
    })) as {
      conversationId: string;
      profile: string;
      sessionId: string | null;
      expiresAt: number | null;
      ttlSeconds: number | null;
      replaced: unknown;
    };

    expect(result.conversationId).toBe(convId);
    expect(result.profile).toBe("fast");
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.ttlSeconds).toBe(600);
    expect(result.replaced).toBeNull();
  });

  test("PUT without ttlSeconds → sessionId=null, expiresAt=null (backwards-compatible sticky)", async () => {
    const convId = crypto.randomUUID();
    seedConversation(convId);

    const result = (await putHandler({
      pathParams: { id: convId },
      body: { profile: "fast" },
    })) as {
      conversationId: string;
      profile: string;
      sessionId: string | null;
      expiresAt: number | null;
      ttlSeconds: unknown;
    };

    expect(result.conversationId).toBe(convId);
    expect(result.profile).toBe("fast");
    expect(result.sessionId).toBeNull();
    expect(result.expiresAt).toBeNull();
  });

  test("PUT profile=A then PUT profile=B with ttlSeconds=600 → second response has replaced: { profile: A, sessionId, expiresAt }", async () => {
    const convId = crypto.randomUUID();
    seedConversation(convId);

    // First PUT — session-backed A
    const first = (await putHandler({
      pathParams: { id: convId },
      body: { profile: "fast", ttlSeconds: 300 },
    })) as { sessionId: string | null };

    const firstSessionId = first.sessionId;
    expect(firstSessionId).toBeTruthy();

    // Second PUT — session-backed B
    const second = (await putHandler({
      pathParams: { id: convId },
      body: { profile: "slow", ttlSeconds: 600 },
    })) as {
      profile: string;
      sessionId: string | null;
      replaced: {
        profile: string | null;
        sessionId: string | null;
        expiresAt: number | null;
      } | null;
    };

    expect(second.profile).toBe("slow");
    expect(second.replaced).not.toBeNull();
    expect(second.replaced!.profile).toBe("fast");
    expect(second.replaced!.sessionId).toBe(firstSessionId);
    expect(second.replaced!.expiresAt).toBeGreaterThan(0);
  });
});

describe("POST /v1/conversations/inference-profile-session (inference_profile_open)", () => {
  beforeEach(() => {
    clearConversations();
    configLlmProfiles = { fast: { model: "model-a" } };
  });

  test("POST with ttlSeconds=600 → same shape as PUT: sessionId UUID, expiresAt, ttlSeconds=600", async () => {
    const convId = crypto.randomUUID();
    seedConversation(convId);

    const result = (await openHandler({
      body: { conversationId: convId, profile: "fast", ttlSeconds: 600 },
    })) as {
      conversationId: string;
      profile: string;
      sessionId: string | null;
      expiresAt: number | null;
      ttlSeconds: number | null;
      replaced: unknown;
    };

    expect(result.conversationId).toBe(convId);
    expect(result.profile).toBe("fast");
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.ttlSeconds).toBe(600);
    expect(result.replaced).toBeNull();
  });
});

describe("GET /v1/conversations/inference-profile-sessions (inference_profile_list)", () => {
  beforeEach(() => {
    clearConversations();
    configLlmProfiles = { fast: { model: "model-a" } };
  });

  test("GET inference-profile-sessions → returns sessions array with remainingSeconds", async () => {
    const convId = crypto.randomUUID();
    seedConversation(convId);

    // Open a session
    await openHandler({
      body: { conversationId: convId, profile: "fast", ttlSeconds: 600 },
    });

    const result = (await listHandler({ queryParams: {} })) as {
      sessions: Array<{
        conversationId: string;
        profile: string;
        sessionId: string;
        expiresAt: number;
        remainingSeconds: number;
      }>;
    };

    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0]!;
    expect(session.conversationId).toBe(convId);
    expect(session.profile).toBe("fast");
    expect(typeof session.sessionId).toBe("string");
    expect(session.remainingSeconds).toBeGreaterThan(0);
    expect(session.remainingSeconds).toBeLessThanOrEqual(600);
  });
});

describe("POST /v1/conversations/inference-profile-session/close (inference_profile_close)", () => {
  beforeEach(() => {
    clearConversations();
    configLlmProfiles = { fast: { model: "model-a" } };
  });

  test("POST inference_profile_close → { noop: false, closed: { profile, sessionId } } after an open", async () => {
    const convId = crypto.randomUUID();
    seedConversation(convId);

    // Open a session first
    const opened = (await openHandler({
      body: { conversationId: convId, profile: "fast", ttlSeconds: 600 },
    })) as { sessionId: string | null };

    const openedSessionId = opened.sessionId;

    // Now close it
    const result = (await closeHandler({
      body: { conversationId: convId },
    })) as {
      conversationId: string;
      noop: boolean;
      closed: { profile: string | null; sessionId: string | null } | null;
    };

    expect(result.noop).toBe(false);
    expect(result.closed).not.toBeNull();
    expect(result.closed!.profile).toBe("fast");
    expect(result.closed!.sessionId).toBe(openedSessionId);
  });

  test("POST inference_profile_close with no active session → { noop: true, closed: null }", async () => {
    const convId = crypto.randomUUID();
    seedConversation(convId);

    const result = (await closeHandler({
      body: { conversationId: convId },
    })) as {
      noop: boolean;
      closed: unknown;
    };

    expect(result.noop).toBe(true);
    expect(result.closed).toBeNull();
  });
});
