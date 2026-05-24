/**
 * LUM-1890 Phase 1 — `POST /v1/conversations/` (`handleCreateConversation`)
 * accepts both `body.conversationId` and `body.conversationKey` as the
 * idempotency key, and emits both `conversationId` and `conversationKey`
 * in the response carrying the same echoed value.
 *
 * Precedence rule: when both inbound fields are sent, `conversationId`
 * wins. When neither is sent, the daemon mints a UUID. Outbound `id`
 * remains the internal `conversations.id` returned by the
 * `getOrCreateConversation` store call.
 *
 * Uses the real conversation-key store + DB. `mock.module` is intentionally
 * avoided here so module mocks don't bleed into other route tests that
 * run later in the same `bun test` process.
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
  broadcastMessage: () => {},
}));

mock.module("../../sync/resource-sync-events.js", () => ({
  publishConversationListAndMetadataChanged: () => {},
  publishConversationListChanged: () => {},
  publishConversationTitleChanged: () => {},
}));

import { getConversationByKey } from "../../../memory/conversation-key-store.js";
import { getDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import { conversationKeys, conversations } from "../../../memory/schema.js";
import { ROUTES as CONVERSATION_MANAGEMENT_ROUTES } from "../conversation-management-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

initializeDb();

function findHandler(routes: RouteDefinition[], operationId: string) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

const createHandler = findHandler(
  CONVERSATION_MANAGEMENT_ROUTES,
  "createConversation",
);

async function callCreate(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const args: RouteHandlerArgs = {
    body,
    headers: {},
    queryParams: {},
    pathParams: {},
  };
  return (await createHandler(args)) as Record<string, unknown>;
}

describe("POST /v1/conversations — Phase 1 bilingual", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(conversationKeys).run();
    db.delete(conversations).run();
  });

  test("accepts body.conversationKey (legacy field) and echoes both names", async () => {
    const requested = "client-key-aaa";
    const result = await callCreate({ conversationKey: requested });

    // The key store must have a mapping under the requested key.
    const mapping = getConversationByKey(requested);
    expect(mapping).not.toBeNull();
    expect(mapping?.conversationId).toBe(result.id as string);

    expect(result.conversationKey).toBe(requested);
    expect(result.conversationId).toBe(requested);
    expect(result.created).toBe(true);
  });

  test("accepts body.conversationId (canonical field) and echoes both names", async () => {
    const requested = "client-id-bbb";
    const result = await callCreate({ conversationId: requested });

    const mapping = getConversationByKey(requested);
    expect(mapping).not.toBeNull();
    expect(mapping?.conversationId).toBe(result.id as string);

    expect(result.conversationId).toBe(requested);
    expect(result.conversationKey).toBe(requested);
  });

  test("prefers body.conversationId over body.conversationKey when both are sent", async () => {
    const idValue = "wins-ccc";
    const keyValue = "loses-ddd";

    const result = await callCreate({
      conversationId: idValue,
      conversationKey: keyValue,
    });

    // The "winning" id materialised a key-store mapping; the "losing" one
    // never did.
    const idMapping = getConversationByKey(idValue);
    const keyMapping = getConversationByKey(keyValue);
    expect(idMapping?.conversationId).toBe(result.id as string);
    expect(keyMapping).toBeNull();

    expect(result.conversationId).toBe(idValue);
    expect(result.conversationKey).toBe(idValue);
  });

  test("mints a UUID when neither field is sent", async () => {
    const result = await callCreate({});

    // UUIDs are 36 characters (8-4-4-4-12).
    expect(typeof result.conversationId).toBe("string");
    expect((result.conversationId as string).length).toBe(36);
    // Both response fields carry the same minted value.
    expect(result.conversationKey).toBe(result.conversationId);
  });
});
