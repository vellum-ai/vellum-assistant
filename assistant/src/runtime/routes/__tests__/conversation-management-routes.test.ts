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

// Stub the event hub to avoid spinning up real SSE infrastructure.
mock.module("../../assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => () => {},
  },
  broadcastMessage: () => {},
}));

// Pinning consults connection availability, which reads the credential store.
// Report a stored key so a seeded connection counts as credentialed.
mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyResultAsync: async () => ({
    value: "test-key",
    unreachable: false,
  }),
}));

import { eq } from "drizzle-orm";

import { setConfig } from "../../../__tests__/helpers/set-config.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import {
  conversations,
  providerConnections,
  scheduleJobs,
} from "../../../persistence/schema/index.js";
import {
  createSchedule,
  getSchedule,
  upsertDeclaredSchedule,
} from "../../../schedule/schedule-store.js";
import { ROUTES as CONVERSATION_MANAGEMENT_ROUTES } from "../conversation-management-routes.js";
import { ROUTES as INFERENCE_PROFILE_SESSION_ROUTES } from "../inference-profile-session-routes.js";
import type { RouteDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

await initializeDb();

// ---------------------------------------------------------------------------
// Config fixture — the handler validates profile names against
// `llm.profiles`, so seed at least one workspace profile. `profileSession`
// keeps its schema default (`maxTtlSeconds: 43200`).
// ---------------------------------------------------------------------------

/**
 * A credentialed connection for `provider`. Pinning a profile to a
 * conversation is refused when the profile provably cannot dispatch, so a
 * profile is only a valid pin target with a connection behind it.
 */
function seedKeyedConnection(provider: string): void {
  const now = Date.now();
  getDb()
    .insert(providerConnections)
    .values({
      name: `${provider}-personal`,
      provider,
      auth: JSON.stringify({
        type: "api_key",
        credential: `credential/${provider}/api_key`,
      }),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
}

function seedProfiles(profiles: Record<string, unknown>): void {
  seedKeyedConnection("anthropic");
  setConfig("llm", { profiles });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findHandler(routes: RouteDefinition[], operationId: string) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const createHandler = findHandler(
  CONVERSATION_MANAGEMENT_ROUTES,
  "createConversation",
);
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

function seedConversation(id: string, scheduleJobId?: string): void {
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
      scheduleJobId,
    })
    .run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/conversations (createConversation)", () => {
  beforeEach(() => {
    clearConversations();
  });

  function readConversation(id: string) {
    return getDb()
      .select({
        title: conversations.title,
        isAutoTitle: conversations.isAutoTitle,
        conversationType: conversations.conversationType,
      })
      .from(conversations)
      .where(eq(conversations.id, id))
      .get();
  }

  test("with a title → persists it as a user-set title (isAutoTitle = 0)", async () => {
    const result = (await createHandler({
      body: { conversationType: "standard", title: "Setting up your check-in" },
    })) as { id: string; created: boolean };

    expect(result.created).toBe(true);
    const row = readConversation(result.id);
    expect(row?.title).toBe("Setting up your check-in");
    // isAutoTitle = 0 keeps the async LLM titler from overwriting it.
    expect(row?.isAutoTitle).toBe(0);
  });

  test("blank title falls back to the replaceable 'New Conversation' placeholder", async () => {
    const result = (await createHandler({
      body: { conversationType: "standard", title: "   " },
    })) as { id: string; created: boolean };

    expect(result.created).toBe(true);
    const row = readConversation(result.id);
    expect(row?.title).toBe("New Conversation");
    // Default auto-title flag (1) leaves it replaceable by the auto-titler.
    expect(row?.isAutoTitle).toBe(1);
  });

  test("no title → 'New Conversation' placeholder", async () => {
    const result = (await createHandler({
      body: { conversationType: "standard" },
    })) as { id: string; created: boolean };

    expect(result.created).toBe(true);
    const row = readConversation(result.id);
    expect(row?.title).toBe("New Conversation");
    expect(row?.isAutoTitle).toBe(1);
  });

  test("non-string title → BadRequestError (not a 500), no row created", () => {
    // The shared route adapter doesn't runtime-validate the body, so the
    // handler must reject a malformed title before `.trim()` throws.
    expect(() =>
      createHandler({ body: { conversationType: "standard", title: 123 } }),
    ).toThrow(/title must be a string/);
    expect(getDb().select().from(conversations).all()).toHaveLength(0);
  });

  test("conversationType: background → persists a background row and echoes it back", async () => {
    const result = (await createHandler({
      body: {
        conversationType: "background",
        title: "Updating personality",
      },
    })) as { id: string; conversationType: string; created: boolean };

    expect(result.created).toBe(true);
    expect(result.conversationType).toBe("background");
    const row = readConversation(result.id);
    expect(row?.conversationType).toBe("background");
    // An explicit title stays user-set on a background row too.
    expect(row?.title).toBe("Updating personality");
    expect(row?.isAutoTitle).toBe(0);
  });

  test("omitted conversationType still creates a standard row", async () => {
    const result = (await createHandler({
      body: { title: "Visible thread" },
    })) as { id: string; conversationType: string };

    expect(result.conversationType).toBe("standard");
    expect(readConversation(result.id)?.conversationType).toBe("standard");
  });

  test("explicit conversationType: null behaves exactly like an omitted one", async () => {
    const result = (await createHandler({
      body: { conversationType: null, title: "Visible thread" },
    })) as { id: string; conversationType: string };

    expect(result.conversationType).toBe("standard");
    expect(readConversation(result.id)?.conversationType).toBe("standard");
  });

  test.each(["scheduled", "nonsense"])(
    "conversationType: %p → BadRequestError, no row created",
    (conversationType) => {
      expect(() => createHandler({ body: { conversationType } })).toThrow(
        /conversationType must be one of standard, background/,
      );
      expect(getDb().select().from(conversations).all()).toHaveLength(0);
    },
  );
});

describe("PUT /v1/conversations/:id/inference-profile", () => {
  beforeEach(() => {
    clearConversations();
    seedProfiles({
      fast: { provider: "anthropic", model: "model-a" },
      slow: { provider: "anthropic", model: "model-b" },
    });
  });

  // The resolver skips a profile carrying no provider and model, so pinning
  // one would leave the conversation running something other than what was
  // chosen. The pin is refused rather than silently honoured.
  test("PUT rejects a profile that cannot dispatch", async () => {
    seedProfiles({ "half-made": { provider: "anthropic" } });
    const convId = crypto.randomUUID();
    seedConversation(convId);
    await expect(
      putHandler({
        pathParams: { id: convId },
        body: { profile: "half-made", ttlSeconds: 600 },
      }),
    ).rejects.toThrow(/provider and a model/);
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
    seedProfiles({ fast: { provider: "anthropic", model: "model-a" } });
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
    seedProfiles({ fast: { provider: "anthropic", model: "model-a" } });
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
    seedProfiles({ fast: { provider: "anthropic", model: "model-a" } });
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

describe("DELETE /v1/conversations/:id (deleteConversation)", () => {
  const deleteHandler = findHandler(
    CONVERSATION_MANAGEMENT_ROUTES,
    "deleteConversation",
  );

  beforeEach(() => {
    clearConversations();
    getDb().delete(scheduleJobs).run();
  });

  test("deleting the last conversation of a plugin-declared schedule keeps the schedule", async () => {
    // GIVEN a plugin-sourced schedule with a single run conversation
    const job = await upsertDeclaredSchedule("plugin:example/daily", {
      name: "daily",
      syntax: "cron",
      expression: "0 9 * * *",
      message: "Do the daily thing.",
      mode: "execute",
      enabled: true,
      definitionHash: "hash-1",
    });
    const convId = crypto.randomUUID();
    seedConversation(convId, job.id);

    // WHEN the conversation is deleted
    await deleteHandler({ pathParams: { id: convId } });

    // THEN the conversation is gone but the schedule row survives: its
    // lifecycle belongs to the reconciler, not conversation cleanup.
    expect(getDb().select().from(conversations).all()).toHaveLength(0);
    expect(getSchedule(job.id)).not.toBeNull();
  });

  test("deleting the last conversation of a user schedule still deletes the schedule", async () => {
    const job = await createSchedule({
      name: "imperative",
      message: "Do the thing.",
      syntax: "cron",
      expression: "0 9 * * *",
    });
    const convId = crypto.randomUUID();
    seedConversation(convId, job.id);

    await deleteHandler({ pathParams: { id: convId } });

    expect(getDb().select().from(conversations).all()).toHaveLength(0);
    expect(getSchedule(job.id)).toBeNull();
  });
});
