import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => false,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
  getGatewayPort: () => 7830,
  getRuntimeHttpPort: () => 7821,
  getRuntimeHttpHost: () => "127.0.0.1",
  getRuntimeGatewayOriginSecret: () => undefined,
  getIngressPublicBaseUrl: () => undefined,
  setIngressPublicBaseUrl: () => {},
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

import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb, resetDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { getPolicy } from "../runtime/auth/route-policy.js";
import { mintToken } from "../runtime/auth/token-service.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";


initializeDb();

const CHAT_WRITE_JWT = mintToken({
  aud: "vellum-daemon",
  sub: "actor:self:fork-route-test",
  scope_profile: "actor_client_v1",
  policy_epoch: 1,
  ttlSeconds: 3600,
});

const READ_ONLY_JWT = mintToken({
  aud: "vellum-daemon",
  sub: "actor:self:fork-route-read-only",
  scope_profile: "ui_page_v1",
  policy_epoch: 1,
  ttlSeconds: 3600,
});

const AUTH_HEADERS = { Authorization: `Bearer ${CHAT_WRITE_JWT}` };
const READ_ONLY_HEADERS = { Authorization: `Bearer ${READ_ONLY_JWT}` };

type ConversationSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  conversationType: string;
  source: string;
  forkParent?: {
    conversationId: string;
    messageId: string;
    title: string;
  };
};

describe("POST /v1/conversations/fork", () => {
  let server: RuntimeHttpServer | null = null;

  beforeEach(async () => {
    await server?.stop();
    server = null;
    clearTables();
  });

  afterAll(async () => {
    await server?.stop();
    resetDb();
  });

  test("returns the same conversation summary shape as GET /v1/conversations/:id", async () => {
    const source = createConversation("Roadmap draft");
    await addMessage(source.id, "user", "Message 1", undefined, {
      skipIndexing: true,
    });
    const branchPoint = await addMessage(
      source.id,
      "assistant",
      "Message 2",
      undefined,
      { skipIndexing: true },
    );
    await addMessage(source.id, "user", "Message 3", undefined, {
      skipIndexing: true,
    });

    await startServer();

    const forkResponse = await fetch(url("/conversations/fork"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationId: source.id,
        throughMessageId: branchPoint.id,
      }),
    });

    expect(forkResponse.status).toBe(200);
    const forkBody = (await forkResponse.json()) as {
      conversation: ConversationSummary;
    };

    expect(forkBody.conversation).toMatchObject({
      title: "Roadmap draft (Fork)",
      conversationType: "standard",
      source: "user",
      forkParent: {
        conversationId: source.id,
        messageId: branchPoint.id,
        title: "Roadmap draft",
      },
    });

    const detailResponse = await fetch(
      url(`/conversations/${forkBody.conversation.id}`),
      { headers: AUTH_HEADERS },
    );
    expect(detailResponse.status).toBe(200);
    const detailBody = (await detailResponse.json()) as {
      conversation: ConversationSummary;
    };

    expect(forkBody).toEqual(detailBody);
  });

  test("rejects empty source conversations", async () => {
    const source = createConversation("Empty source");

    await startServer();

    const response = await fetch(url("/conversations/fork"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ conversationId: source.id }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: `Conversation ${source.id} has no persisted messages to fork`,
      },
    });
  });

  test("returns NOT_FOUND when the source conversation does not exist", async () => {
    await startServer();

    const response = await fetch(url("/conversations/fork"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ conversationId: "missing-conversation" }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Conversation missing-conversation not found",
      },
    });
  });

  test("rejects nonexistent and cross-conversation branch point message IDs", async () => {
    const source = createConversation("Source");
    await addMessage(source.id, "user", "Source message", undefined, {
      skipIndexing: true,
    });
    const otherConversation = createConversation("Other");
    const otherMessage = await addMessage(
      otherConversation.id,
      "assistant",
      "Other message",
      undefined,
      { skipIndexing: true },
    );

    await startServer();

    const missingMessageResponse = await fetch(url("/conversations/fork"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationId: source.id,
        throughMessageId: "missing-message-id",
      }),
    });

    expect(missingMessageResponse.status).toBe(404);
    expect(await missingMessageResponse.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: `Message missing-message-id does not belong to conversation ${source.id}`,
      },
    });

    const crossConversationResponse = await fetch(url("/conversations/fork"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationId: source.id,
        throughMessageId: otherMessage.id,
      }),
    });

    expect(crossConversationResponse.status).toBe(404);
    expect(await crossConversationResponse.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: `Message ${otherMessage.id} does not belong to conversation ${source.id}`,
      },
    });
  });

  test("requires chat.write scope", async () => {
    const source = createConversation("Auth gated");

    await startServer();

    const response = await fetch(url("/conversations/fork"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...READ_ONLY_HEADERS },
      body: JSON.stringify({ conversationId: source.id }),
    });

    expect(getPolicy("conversations/fork")).toEqual({
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ["actor", "svc_gateway", "svc_daemon", "local"],
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Missing required scope: chat.write",
      },
    });
  });

  async function startServer(): Promise<void> {
    server = new RuntimeHttpServer({ port: 0 });
    await server.start();
  }

  function clearTables(): void {
    const db = getDb();
    db.run("DELETE FROM conversation_assistant_attention_state");
    db.run("DELETE FROM external_conversation_bindings");
    db.run("DELETE FROM conversation_keys");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  }

  function url(pathname: string): string {
    if (!server) throw new Error("server not started");
    return `http://127.0.0.1:${server.actualPort}/v1${pathname}`;
  }
});
