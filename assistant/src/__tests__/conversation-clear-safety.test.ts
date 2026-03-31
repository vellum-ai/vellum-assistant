/**
 * Safety tests for DELETE /v1/conversations (clear all conversations).
 *
 * Covers:
 * - Route policy requires `settings.write` scope (not just `chat.write`)
 * - Missing X-Confirm-Destructive header returns 400 with explanatory message
 * - Wrong header value returns 400
 * - Correct scope + header clears data and returns 204
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

import {
  addMessage,
  clearAll,
  createConversation,
  getConversation,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb } from "../memory/db.js";
import { enforcePolicy, getPolicy } from "../runtime/auth/route-policy.js";
import type { AuthContext, Scope } from "../runtime/auth/types.js";
import { conversationManagementRouteDefinitions } from "../runtime/routes/conversation-management-routes.js";

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

    // A chat.write token should pass the single-conversation delete policy
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
  /** Get the DELETE conversations handler from the route definitions. */
  function getDeleteHandler() {
    let clearCalled = false;
    const routes = conversationManagementRouteDefinitions({
      switchConversation: async () => null,
      renameConversation: () => true,
      clearAllConversations: () => {
        clearCalled = true;
        return clearAll().conversations;
      },
      cancelGeneration: () => true,
      destroyConversation: () => {},
      undoLastMessage: async () => null,
      regenerateResponse: async () => null,
    });

    const deleteRoute = routes.find(
      (r) => r.endpoint === "conversations" && r.method === "DELETE",
    );
    if (!deleteRoute) throw new Error("DELETE conversations route not found");
    return { handler: deleteRoute.handler, wasClearCalled: () => clearCalled };
  }

  test("missing X-Confirm-Destructive header returns 400 with explanatory message", async () => {
    const { handler } = getDeleteHandler();
    const req = new Request("http://localhost/v1/conversations", {
      method: "DELETE",
    });
    const response = await handler({
      req,
      url: new URL(req.url),
      server: {} as never,
      authContext: buildAuthContext({ scopes: ["settings.write"] }),
      params: {},
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("X-Confirm-Destructive");
    expect(body.error.message).toContain("clear-all-conversations");
  });

  test("wrong X-Confirm-Destructive header value returns 400", async () => {
    const { handler } = getDeleteHandler();
    const req = new Request("http://localhost/v1/conversations", {
      method: "DELETE",
      headers: { "X-Confirm-Destructive": "wrong-value" },
    });
    const response = await handler({
      req,
      url: new URL(req.url),
      server: {} as never,
      authContext: buildAuthContext({ scopes: ["settings.write"] }),
      params: {},
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("correct scope + header clears data and returns 204", async () => {
    // Seed a conversation so we can verify it gets cleared
    const conv = createConversation("safety-test-conv");
    await addMessage(conv.id, "user", "hello from safety test");
    expect(getConversation(conv.id)).not.toBeNull();

    const { handler, wasClearCalled } = getDeleteHandler();
    const req = new Request("http://localhost/v1/conversations", {
      method: "DELETE",
      headers: { "X-Confirm-Destructive": "clear-all-conversations" },
    });
    const response = await handler({
      req,
      url: new URL(req.url),
      server: {} as never,
      authContext: buildAuthContext({ scopes: ["settings.write"] }),
      params: {},
    });
    expect(response.status).toBe(204);
    expect(wasClearCalled()).toBe(true);

    // Conversation should be gone
    expect(getConversation(conv.id)).toBeNull();
  });

  test("lifecycle_events contains conversations_clear_all after successful clear", async () => {
    const { handler } = getDeleteHandler();
    const req = new Request("http://localhost/v1/conversations", {
      method: "DELETE",
      headers: { "X-Confirm-Destructive": "clear-all-conversations" },
    });
    await handler({
      req,
      url: new URL(req.url),
      server: {} as never,
      authContext: buildAuthContext({ scopes: ["settings.write"] }),
      params: {},
    });

    // Query lifecycle_events table directly
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
