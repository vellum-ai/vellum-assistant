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

let cancelledId: string | undefined;
mock.module("../daemon/handlers/conversations.js", () => ({
  cancelGeneration: (id: string) => {
    cancelledId = id;
    return true;
  },
  switchConversation: async () => null,
  clearAllConversations: () => 0,
  undoLastMessage: async () => null,
  regenerateResponse: async () => null,
}));

import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import { initializeDb } from "../memory/db-init.js";
import { ROUTES } from "../runtime/routes/conversation-management-routes.js";
import { routeDefinitionsToHTTPRoutes } from "../runtime/routes/http-adapter.js";

initializeDb();

describe("POST /v1/conversations/:id/cancel", () => {
  const cancelRoute = ROUTES.find(
    (r) => r.operationId === "cancelConversationGeneration",
  )!;

  test("resolves conversation key to internal ID before cancelling", () => {
    cancelledId = undefined;
    const conversationKey = "client-local-uuid-abc123";
    const mapping = getOrCreateConversation(conversationKey);
    const internalId = mapping.conversationId;

    expect(internalId).not.toBe(conversationKey);

    const result = cancelRoute.handler({
      pathParams: { id: conversationKey },
      body: {},
      headers: {},
    });

    expect(cancelledId!).toBe(internalId);
    expect(result).toEqual({
      ok: true,
      cancelled: true,
      conversationId: internalId,
    });
  });

  test("falls back to raw ID when key is not in the mapping", () => {
    cancelledId = undefined;
    const directId = "direct-conversation-id";

    const result = cancelRoute.handler({
      pathParams: { id: directId },
      body: {},
      headers: {},
    });

    expect(cancelledId!).toBe(directId);
    expect(result).toEqual({
      ok: true,
      cancelled: true,
      conversationId: directId,
    });
  });

  test("HTTP adapter returns a serializable 202 response", async () => {
    cancelledId = undefined;
    const directId = "direct-http-conversation-id";
    const [httpRoute] = routeDefinitionsToHTTPRoutes([cancelRoute]);
    const url = new URL(`http://localhost/v1/conversations/${directId}/cancel`);

    const response = await httpRoute.handler({
      req: new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      url,
      params: { id: directId },
      authContext: {} as never,
      server: {} as never,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      cancelled: true,
      conversationId: directId,
    });
    expect(cancelledId!).toBe(directId);
  });

  test("route definition advertises the cancellation response body", () => {
    expect(cancelRoute.responseStatus).toBe("202");
    expect(cancelRoute.responseBody).toBeDefined();
  });
});
