import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const config = {
  llm: {
    profiles: {
      "quality-optimized": {},
      balanced: {},
      "cost-optimized": {},
    },
  },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => config,
  getConfig: () => config,
}));

import {
  createConversation,
  getConversation,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { conversationManagementRouteDefinitions } from "../runtime/routes/conversation-management-routes.js";

initializeDb();

const routes = conversationManagementRouteDefinitions({
  switchConversation: async (conversationId) => ({
    conversationId,
    title: "Switched",
    conversationType: "standard",
    hostAccess: false,
  }),
  renameConversation: () => true,
  clearAllConversations: () => 0,
  cancelGeneration: () => true,
  destroyConversation: () => {},
  undoLastMessage: async () => null,
  regenerateResponse: async () => null,
});

function findRoute(method: string, endpoint: string) {
  const route = routes.find(
    (routeDef) => routeDef.method === method && routeDef.endpoint === endpoint,
  );
  if (!route) {
    throw new Error(`Route not found: ${method} ${endpoint}`);
  }
  return route;
}

function clearTables(): void {
  const db = getDb();
  db.run("DELETE FROM conversation_assistant_attention_state");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

describe("PUT /v1/conversations/:id/inference-profile", () => {
  beforeEach(() => {
    clearTables();
  });

  afterAll(() => {
    resetDb();
    mock.restore();
  });

  test("sets the override and emits a hub event for a known profile", async () => {
    const conversation = createConversation("inference-profile-route");

    const received: Array<{
      assistantId: string;
      type: string;
      conversationId?: string;
      profile?: string | null;
    }> = [];
    const subscription = assistantEventHub.subscribe(
      { assistantId: DAEMON_INTERNAL_ASSISTANT_ID },
      (event) => {
        received.push({
          assistantId: event.assistantId,
          type: event.message.type,
          conversationId: event.conversationId,
          profile:
            event.message.type === "conversation_inference_profile_updated"
              ? event.message.profile
              : undefined,
        });
      },
    );

    const route = findRoute("PUT", "conversations/:id/inference-profile");
    const response = await route.handler({
      req: new Request(
        `http://localhost/v1/conversations/${conversation.id}/inference-profile`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: "quality-optimized" }),
        },
      ),
      url: new URL(
        `http://localhost/v1/conversations/${conversation.id}/inference-profile`,
      ),
      server: null as never,
      authContext: {} as never,
      params: { id: conversation.id },
    });

    await Promise.resolve();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      conversationId: conversation.id,
      profile: "quality-optimized",
    });
    expect(getConversation(conversation.id)?.inferenceProfile).toBe(
      "quality-optimized",
    );
    expect(received).toEqual([
      {
        assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
        type: "conversation_inference_profile_updated",
        conversationId: conversation.id,
        profile: "quality-optimized",
      },
    ]);

    subscription.dispose();
  });

  test("rejects unknown profile names with 400", async () => {
    const conversation = createConversation("inference-profile-unknown");

    const route = findRoute("PUT", "conversations/:id/inference-profile");
    const response = await route.handler({
      req: new Request(
        `http://localhost/v1/conversations/${conversation.id}/inference-profile`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: "does-not-exist" }),
        },
      ),
      url: new URL(
        `http://localhost/v1/conversations/${conversation.id}/inference-profile`,
      ),
      server: null as never,
      authContext: {} as never,
      params: { id: conversation.id },
    });

    expect(response.status).toBe(400);
    expect(getConversation(conversation.id)?.inferenceProfile).toBeNull();
  });

  test("clears the override when profile is null", async () => {
    const conversation = createConversation("inference-profile-clear");

    // Seed an override first via the route.
    const setRoute = findRoute("PUT", "conversations/:id/inference-profile");
    const setResponse = await setRoute.handler({
      req: new Request(
        `http://localhost/v1/conversations/${conversation.id}/inference-profile`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: "balanced" }),
        },
      ),
      url: new URL(
        `http://localhost/v1/conversations/${conversation.id}/inference-profile`,
      ),
      server: null as never,
      authContext: {} as never,
      params: { id: conversation.id },
    });
    expect(setResponse.status).toBe(200);
    expect(getConversation(conversation.id)?.inferenceProfile).toBe("balanced");

    const received: Array<{ profile?: string | null }> = [];
    const subscription = assistantEventHub.subscribe(
      { assistantId: DAEMON_INTERNAL_ASSISTANT_ID },
      (event) => {
        if (event.message.type === "conversation_inference_profile_updated") {
          received.push({ profile: event.message.profile });
        }
      },
    );

    const clearResponse = await setRoute.handler({
      req: new Request(
        `http://localhost/v1/conversations/${conversation.id}/inference-profile`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: null }),
        },
      ),
      url: new URL(
        `http://localhost/v1/conversations/${conversation.id}/inference-profile`,
      ),
      server: null as never,
      authContext: {} as never,
      params: { id: conversation.id },
    });

    await Promise.resolve();

    expect(clearResponse.status).toBe(200);
    expect(await clearResponse.json()).toEqual({
      conversationId: conversation.id,
      profile: null,
    });
    expect(getConversation(conversation.id)?.inferenceProfile).toBeNull();
    expect(received).toEqual([{ profile: null }]);

    subscription.dispose();
  });

  test("skips write and event when the profile is unchanged", async () => {
    const conversation = createConversation("inference-profile-noop");

    const route = findRoute("PUT", "conversations/:id/inference-profile");
    const setResponse = await route.handler({
      req: new Request(
        `http://localhost/v1/conversations/${conversation.id}/inference-profile`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: "balanced" }),
        },
      ),
      url: new URL(
        `http://localhost/v1/conversations/${conversation.id}/inference-profile`,
      ),
      server: null as never,
      authContext: {} as never,
      params: { id: conversation.id },
    });
    expect(setResponse.status).toBe(200);
    const updatedAtAfterSet = getConversation(conversation.id)?.updatedAt;

    const received: Array<{ profile?: string | null }> = [];
    const subscription = assistantEventHub.subscribe(
      { assistantId: DAEMON_INTERNAL_ASSISTANT_ID },
      (event) => {
        if (event.message.type === "conversation_inference_profile_updated") {
          received.push({ profile: event.message.profile });
        }
      },
    );

    const repeatResponse = await route.handler({
      req: new Request(
        `http://localhost/v1/conversations/${conversation.id}/inference-profile`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: "balanced" }),
        },
      ),
      url: new URL(
        `http://localhost/v1/conversations/${conversation.id}/inference-profile`,
      ),
      server: null as never,
      authContext: {} as never,
      params: { id: conversation.id },
    });

    await Promise.resolve();

    expect(repeatResponse.status).toBe(200);
    expect(await repeatResponse.json()).toEqual({
      conversationId: conversation.id,
      profile: "balanced",
    });
    expect(getConversation(conversation.id)?.updatedAt).toBe(updatedAtAfterSet);
    expect(received).toEqual([]);

    subscription.dispose();
  });

  test("returns 404 when the conversation does not exist", async () => {
    const route = findRoute("PUT", "conversations/:id/inference-profile");
    const response = await route.handler({
      req: new Request(
        "http://localhost/v1/conversations/missing/inference-profile",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: "balanced" }),
        },
      ),
      url: new URL(
        "http://localhost/v1/conversations/missing/inference-profile",
      ),
      server: null as never,
      authContext: {} as never,
      params: { id: "missing" },
    });

    expect(response.status).toBe(404);
  });
});
