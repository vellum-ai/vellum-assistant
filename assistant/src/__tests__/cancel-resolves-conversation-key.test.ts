/**
 * Regression test: POST /v1/conversations/:id/cancel must resolve the
 * conversation key to the internal conversation ID before calling
 * cancelGeneration(). Without resolveConversationId(), the cancel
 * endpoint receives the client's local conversation key (which differs
 * from the daemon's internal ID), fails to find the conversation, and
 * silently ignores the cancel — leaving the stream running.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    contextWindow: { maxInputTokens: 200000 },
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
    },
  }),
}));

import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import { initializeDb } from "../memory/db.js";
import { conversationManagementRouteDefinitions } from "../runtime/routes/conversation-management-routes.js";

initializeDb();

describe("POST /v1/conversations/:id/cancel", () => {
  test("resolves conversation key to internal ID before cancelling", () => {
    // Create a conversation via key — this assigns an internal ID that
    // differs from the key.
    const conversationKey = "client-local-uuid-abc123";
    const mapping = getOrCreateConversation(conversationKey);
    const internalId = mapping.conversationId;

    // Sanity: key and internal ID should differ.
    expect(internalId).not.toBe(conversationKey);

    // Track which ID cancelGeneration receives.
    let cancelledId: string | undefined;
    const routes = conversationManagementRouteDefinitions({
      switchConversation: async () => null,
      renameConversation: () => false,
      clearAllConversations: () => 0,
      cancelGeneration: (id) => {
        cancelledId = id;
        return true;
      },
      destroyConversation: () => {},
      undoLastMessage: async () => null,
      regenerateResponse: async () => null,
    });

    const cancelRoute = routes.find(
      (r) => r.endpoint === "conversations/:id/cancel",
    )!;

    // Simulate the HTTP handler with the conversation KEY (what the
    // macOS client sends — it uses the key, not the internal ID).
    cancelRoute.handler({
      params: { id: conversationKey },
      req: new Request("http://localhost/v1/conversations/x/cancel", {
        method: "POST",
      }),
      url: new URL("http://localhost/v1/conversations/x/cancel"),
      server: undefined as never,
      authContext: undefined as never,
    });

    // cancelGeneration must receive the INTERNAL ID, not the raw key.
    expect(cancelledId).toBe(internalId);
  });

  test("falls back to raw ID when key is not in the mapping", () => {
    let cancelledId: string | undefined;
    const routes = conversationManagementRouteDefinitions({
      switchConversation: async () => null,
      renameConversation: () => false,
      clearAllConversations: () => 0,
      cancelGeneration: (id) => {
        cancelledId = id;
        return true;
      },
      destroyConversation: () => {},
      undoLastMessage: async () => null,
      regenerateResponse: async () => null,
    });

    const cancelRoute = routes.find(
      (r) => r.endpoint === "conversations/:id/cancel",
    )!;

    // Use an ID that isn't a known key — should pass through as-is.
    const directId = "direct-conversation-id";
    cancelRoute.handler({
      params: { id: directId },
      req: new Request("http://localhost/v1/conversations/x/cancel", {
        method: "POST",
      }),
      url: new URL("http://localhost/v1/conversations/x/cancel"),
      server: undefined as never,
      authContext: undefined as never,
    });

    expect(cancelledId).toBe(directId);
  });
});
