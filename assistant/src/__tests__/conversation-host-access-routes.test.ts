import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

let authDisabled = true;
let boundGuardianPrincipalId: string | null = null;

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => authDisabled,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
  getGatewayPort: () => 7830,
  getRuntimeHttpPort: () => 7821,
  getRuntimeHttpHost: () => "127.0.0.1",
  getRuntimeGatewayOriginSecret: () => undefined,
  getIngressPublicBaseUrl: () => undefined,
  setIngressPublicBaseUrl: () => {},
}));

mock.module("../contacts/contact-store.js", () => ({
  findGuardianForChannel: () =>
    boundGuardianPrincipalId
      ? {
          channel: { externalUserId: undefined },
          contact: { principalId: boundGuardianPrincipalId },
        }
      : null,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import {
  createConversation,
  updateConversationHostAccess,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import { conversationManagementRouteDefinitions } from "../runtime/routes/conversation-management-routes.js";

initializeDb();

const routes = conversationManagementRouteDefinitions({
  switchConversation: async (conversationId) => {
    const conversation = {
      conversationId,
      title: "Switched conversation",
      conversationType: "standard",
      hostAccess: false,
    };
    return conversation;
  },
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

describe("conversation host-access transport", () => {
  let server: RuntimeHttpServer | null = null;

  beforeEach(async () => {
    await server?.stop();
    server = null;
    authDisabled = true;
    boundGuardianPrincipalId = null;
    clearTables();
  });

  afterAll(async () => {
    await server?.stop();
    resetDb();
    mock.restore();
  });

  test("GET and PATCH /v1/conversations/:id/host-access use the conversation store", async () => {
    const conversation = createConversation("Host access test");

    const getRoute = findRoute("GET", "conversations/:id/host-access");
    const getResponse = await getRoute.handler({
      req: new Request("http://localhost/v1/conversations/test/host-access"),
      url: new URL("http://localhost/v1/conversations/test/host-access"),
      server: null as never,
      authContext: {} as never,
      params: { id: conversation.id },
    });

    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual({
      conversationId: conversation.id,
      hostAccess: false,
    });

    const received: Array<{
      assistantId: string;
      type: string;
      conversationId?: string;
      hostAccess?: boolean;
    }> = [];
    const subscription = assistantEventHub.subscribe(
      { assistantId: DAEMON_INTERNAL_ASSISTANT_ID },
      (event) => {
        received.push({
          assistantId: event.assistantId,
          type: event.message.type,
          conversationId: event.conversationId,
          hostAccess:
            event.message.type === "conversation_host_access_updated"
              ? event.message.hostAccess
              : undefined,
        });
      },
    );

    const patchRoute = findRoute("PATCH", "conversations/:id/host-access");
    const patchResponse = await patchRoute.handler({
      req: new Request("http://localhost/v1/conversations/test/host-access", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostAccess: true }),
      }),
      url: new URL("http://localhost/v1/conversations/test/host-access"),
      server: null as never,
      authContext: {} as never,
      params: { id: conversation.id },
    });

    await Promise.resolve();

    expect(patchResponse.status).toBe(200);
    expect(await patchResponse.json()).toEqual({
      conversationId: conversation.id,
      hostAccess: true,
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
      type: "conversation_host_access_updated",
      conversationId: conversation.id,
      hostAccess: true,
    });
    subscription.dispose();
  });

  test("conversation summaries include hostAccess", async () => {
    const conversation = createConversation("Summary host access");
    updateConversationHostAccess(conversation.id, true);

    server = new RuntimeHttpServer({
      port: 0,
      bearerToken: "test-bearer-token",
    });
    await server.start();

    const response = await fetch(
      `http://127.0.0.1:${server.actualPort}/v1/conversations/${conversation.id}`,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      conversation: {
        id: string;
        hostAccess: boolean;
      };
    };

    expect(body.conversation.id).toBe(conversation.id);
    expect(body.conversation.hostAccess).toBe(true);
  });

  test("PATCH /v1/conversations/:id/host-access rejects non-guardian actors when auth is enforced", async () => {
    authDisabled = false;
    boundGuardianPrincipalId = "guardian-principal";
    const conversation = createConversation("Guarded host access");

    const patchRoute = findRoute("PATCH", "conversations/:id/host-access");
    const patchResponse = await patchRoute.handler({
      req: new Request("http://localhost/v1/conversations/test/host-access", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostAccess: true }),
      }),
      url: new URL("http://localhost/v1/conversations/test/host-access"),
      server: null as never,
      authContext: {
        actorPrincipalId: "trusted-contact-principal",
      } as never,
      params: { id: conversation.id },
    });

    expect(patchResponse.status).toBe(403);
  });
});
