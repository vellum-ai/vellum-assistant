/**
 * Safety tests for DELETE /v1/conversations (clear all conversations).
 *
 * Covers:
 * - Route policy requires `settings.write` scope (not just `chat.write`)
 * - Missing X-Confirm-Destructive header returns BadRequestError
 * - Wrong header value returns BadRequestError
 * - Correct header clears data
 * - telemetry_events contains the `conversations_clear_all` audit entry after clear
 */

import { describe, expect, mock, test } from "bun:test";

// Auth is NOT disabled — we need enforcePolicy to actually check scopes.
let authDisabled = false;
mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => authDisabled,
  hasUngatedHttpAuthDisabled: () => false,
}));

mock.module("../daemon/handlers/conversations.js", () => ({
  cancelGeneration: () => true,
  clearAllConversations: async () => {
    await clearAll();
    return 0;
  },
  switchConversation: async () => null,
  undoLastMessage: async () => null,
}));

import {
  addMessage,
  clearAll,
  createConversation,
  getConversation,
} from "../persistence/conversation-crud.js";
import { getTelemetrySqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { enforcePolicy } from "../runtime/auth/route-policy.js";
import type { AuthContext, Scope } from "../runtime/auth/types.js";
import { ROUTES } from "../runtime/routes/conversation-management-routes.js";

/** Look up a route's policy by endpoint+method on the route module's ROUTES. */
function routePolicy(endpoint: string, method?: string) {
  const route = ROUTES.find(
    (r) => r.endpoint === endpoint && (!method || r.method === method),
  );
  return route?.policy ?? null;
}
import { BadRequestError } from "../runtime/routes/errors.js";

await initializeDb();

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
  test("DELETE /conversations requires settings.write scope", () => {
    authDisabled = false;
    const policy = routePolicy("conversations", "DELETE");
    expect(policy).not.toBeNull();
    expect(policy!.requiredScopes).toContain("settings.write");
  });

  test("chat.write-only token is rejected with 403 for clear-all", () => {
    authDisabled = false;
    const policy = routePolicy("conversations", "DELETE");
    const ctx = buildAuthContext({
      scopes: ["chat.read", "chat.write"],
    });
    const result = enforcePolicy("conversations", policy, ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("settings.write token is allowed through clear-all policy", () => {
    authDisabled = false;
    const policy = routePolicy("conversations", "DELETE");
    const ctx = buildAuthContext({
      scopes: ["settings.write"],
    });
    const result = enforcePolicy("conversations", policy, ctx);
    expect(result).toBeNull();
  });

  test("single-conversation DELETE only requires chat.write", () => {
    authDisabled = false;
    const policy = routePolicy("conversations/:id", "DELETE");
    expect(policy).not.toBeNull();
    expect(policy!.requiredScopes).toContain("chat.write");
    expect(policy!.requiredScopes).not.toContain("settings.write");

    const ctx = buildAuthContext({
      scopes: ["chat.read", "chat.write"],
    });
    const result = enforcePolicy("conversations/:id", policy, ctx);
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

  test("missing X-Confirm-Destructive header throws BadRequestError", async () => {
    await expect(
      Promise.resolve().then(() =>
        clearRoute.handler({
          pathParams: {},
          body: {},
          headers: {},
        }),
      ),
    ).rejects.toThrow(BadRequestError);
  });

  test("wrong X-Confirm-Destructive header value throws BadRequestError", async () => {
    await expect(
      Promise.resolve().then(() =>
        clearRoute.handler({
          pathParams: {},
          body: {},
          headers: { "x-confirm-destructive": "wrong-value" },
        }),
      ),
    ).rejects.toThrow(BadRequestError);
  });

  test("correct header clears data", async () => {
    const conv = createConversation("safety-test-conv");
    await addMessage(conv.id, "user", "hello from safety test");
    expect(getConversation(conv.id)).not.toBeNull();

    const result = await clearRoute.handler({
      pathParams: {},
      body: {},
      headers: { "x-confirm-destructive": "clear-all-conversations" },
    });
    expect(result).toBeUndefined();

    expect(getConversation(conv.id)).toBeNull();
  });

  test("telemetry_events contains conversations_clear_all after successful clear", async () => {
    await clearRoute.handler({
      pathParams: {},
      body: {},
      headers: { "x-confirm-destructive": "clear-all-conversations" },
    });

    // The audit row lands in the telemetry_events outbox on the dedicated
    // telemetry DB; the durable trail persists platform-side once flushed.
    const rows = getTelemetrySqlite()!
      .query(
        "SELECT id, payload FROM telemetry_events WHERE name = 'lifecycle'",
      )
      .all() as Array<{ id: string; payload: string }>;
    const audits = rows
      .map((r) => ({
        id: r.id,
        payload: JSON.parse(r.payload) as Record<string, unknown>,
      }))
      .filter((r) => r.payload.event_name === "conversations_clear_all");
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].payload).toMatchObject({
      type: "lifecycle",
      daemon_event_id: audits[0].id,
      event_name: "conversations_clear_all",
    });
  });
});
