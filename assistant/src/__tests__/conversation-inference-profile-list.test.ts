/**
 * Tests that the conversation list/detail HTTP responses serialize the
 * per-conversation `inferenceProfile` override.
 *
 * The macOS chat picker pill reads `inferenceProfile` from
 * `GET /v1/conversations` and `GET /v1/conversations/:id`. Without it the
 * pill renders "Default" for every conversation after an app restart, even
 * when the DB has a pinned profile.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
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
  }),
}));

import {
  createConversation,
  setConversationInferenceProfile,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";

initializeDb();

type ConversationSummary = {
  id: string;
  title: string;
  inferenceProfile?: string;
};

describe("conversation HTTP responses include inferenceProfile", () => {
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

  test("GET /v1/conversations includes inferenceProfile for pinned conversations and omits it when unset", async () => {
    const pinned = createConversation("Pinned-profile conversation");
    const unset = createConversation("Default-profile conversation");
    await setConversationInferenceProfile(pinned.id, "quality-optimized");

    await startServer();

    const response = await fetch(url("/conversations"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      conversations: ConversationSummary[];
    };
    const pinnedListed = body.conversations.find((c) => c.id === pinned.id);
    const unsetListed = body.conversations.find((c) => c.id === unset.id);
    expect(pinnedListed).toBeDefined();
    expect(unsetListed).toBeDefined();
    expect(pinnedListed?.inferenceProfile).toBe("quality-optimized");
    expect(unsetListed?.inferenceProfile).toBeUndefined();
  });

  test("GET /v1/conversations/:id includes inferenceProfile in the detail response", async () => {
    const conv = createConversation("Detail-profile conversation");
    await setConversationInferenceProfile(conv.id, "balanced");

    await startServer();

    const response = await fetch(url(`/conversations/${conv.id}`));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      conversation: ConversationSummary;
    };
    expect(body.conversation.id).toBe(conv.id);
    expect(body.conversation.inferenceProfile).toBe("balanced");
  });

  function clearTables(): void {
    const db = getDb();
    db.run("DELETE FROM conversation_assistant_attention_state");
    db.run("DELETE FROM external_conversation_bindings");
    db.run("DELETE FROM conversation_keys");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  }

  async function startServer(): Promise<void> {
    server = new RuntimeHttpServer({
      port: 0,
      bearerToken: "test-bearer-token",
    });
    await server.start();
  }

  function url(pathname: string): string {
    if (!server) throw new Error("server not started");
    return `http://127.0.0.1:${server.actualPort}/v1${pathname}`;
  }
});
