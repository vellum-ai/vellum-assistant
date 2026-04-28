/**
 * Safety tests for DELETE /v1/conversations (clear all conversations).
 *
 * Covers:
 * - Route policy requires `settings.write` scope (not just `chat.write`)
 * - Missing X-Confirm-Destructive header returns BadRequestError
 * - Wrong header value returns BadRequestError
 * - Correct header clears data
 * - lifecycle_events contains `conversations_clear_all` audit entry after clear
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Auth is NOT disabled — we need enforcePolicy to actually check scopes.
let authDisabled = false;
mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => authDisabled,
  hasUngatedHttpAuthDisabled: () => false,
}));

mock.module("../daemon/handlers/conversations.js", () => ({
  cancelGeneration: () => true,
  clearAllConversations: () => {
    clearAll();
    return 0;
  },
  switchConversation: async () => null,
  undoLastMessage: async () => null,
  regenerateResponse: async () => null,
}));

import {
  addMessage,
  clearAll,
  createConversation,
  getConversation,
} from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { enforcePolicy, getPolicy } from "../runtime/auth/route-policy.js";
import type { AuthContext, Scope } from "../runtime/auth/types.js";
import { ROUTES } from "../runtime/routes/conversation-management-routes.js";
import { BadRequestError } from "../runtime/routes/errors.js";

initializeDb();

/** Build a synthetic AuthContext for testing. */
function buildAuthContext(overrides?: {
  principalType?: AuthContext["principalType"];
  scopes?: Scope[];
}): AuthContext {
  return {
    subject: "actor:self:test-principal",
    principalType: overrides?.principalType ?? "actor",
    assistantId: "self",
    actorPrincipalId: "test-principal",
    scopeProfile: "actor_client_v1",
    scopes: new Set(
      overrides?.scopes ?? [
        "chat.read",
        "chat.write",
        "approval.read",
        "approval.write",
      ],
    ),
    policyEpoch: 1,
  };
}

// ---------------------------------------------------------------------------
// Route policy tests (scope check — enforcePolicy level)
// ---------------------------------------------------------------------------

describe("DELETE /v1/conversations — route policy", () => {
  test("conversations/clear-all requires settings.write scope", () => {
    authDisabled = false;
    const policy = getPolicy("conversations/clear-all");
    expect(policy).toBeDefined();
    expect(policy!.requiredScopes).toContain("settings.write");
  });

  test("chat.write-only token is rejected with 403 for clear-all", () => {
    authDisabled = false;
    const ctx = buildAuthContext({
      scopes: ["chat.read", "chat.write"],
    });
    const result = enforcePolicy("conversations/clear-all", ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("settings.write token is allowed through clear-all policy", () => {
    authDisabled = false;
    const ctx = buildAuthContext({
      scopes: ["settings.write"],
    });
    const result = enforcePolicy("conversations/clear-all", ctx);
    expect(result).toBeNull();
  });

  test("single-conversation DELETE (conversations:DELETE) only requires chat.write", () => {
    authDisabled = false;
    const policy = getPolicy("conversations:DELETE");
    expect(policy).toBeDefined();
    expect(policy!.requiredScopes).toContain("chat.write");
    expect(policy!.requiredScopes).not.toContain("settings.write");

    const ctx = buildAuthContext({
      scopes: ["chat.read", "chat.write"],
    });
    const result = enforcePolicy("conversations:DELETE", ctx);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Route handler tests (header check + happy path)
// ---------------------------------------------------------------------------

describe("DELETE /v1/conversations — route handler", () => {
  const clearRoute = ROUTES.find(
    (r) => r.operationId === "clearAllConversations",
  )!;

  test("missing X-Confirm-Destructive header throws BadRequestError", () => {
    expect(() =>
      clearRoute.handler({
        pathParams: {},
        body: {},
        headers: {},
  
      }),
    ).toThrow(BadRequestError);
  });

  test("wrong X-Confirm-Destructive header value throws BadRequestError", () => {
    expect(() =>
      clearRoute.handler({
        pathParams: {},
        body: {},
        headers: { "x-confirm-destructive": "wrong-value" },
  
      }),
    ).toThrow(BadRequestError);
  });

  test("correct header clears data", async () => {
    const conv = createConversation("safety-test-conv");
    await addMessage(conv.id, "user", "hello from safety test");
    expect(getConversation(conv.id)).not.toBeNull();

    const result = clearRoute.handler({
      pathParams: {},
      body: {},
      headers: { "x-confirm-destructive": "clear-all-conversations" },

    });
    expect(result).toBeUndefined();

    expect(getConversation(conv.id)).toBeNull();
  });

  test("lifecycle_events contains conversations_clear_all after successful clear", () => {
    clearRoute.handler({
      pathParams: {},
      body: {},
      headers: { "x-confirm-destructive": "clear-all-conversations" },

    });

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;
    const rows = raw
      .query(
        "SELECT event_name FROM lifecycle_events WHERE event_name = 'conversations_clear_all'",
      )
      .all() as Array<{ event_name: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].event_name).toBe("conversations_clear_all");
  });
});
