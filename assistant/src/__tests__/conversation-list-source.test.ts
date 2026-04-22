/**
 * Tests for the `source` discriminator on GET /v1/conversations.
 *
 * The conversation-list HTTP response must include the `source` field for
 * each conversation so the macOS sidebar (and other clients) can filter
 * and group conversations by their origin (e.g. user, auto-analysis).
 *
 * Covers:
 *   - Every listed conversation carries a `source` field.
 *   - Conversations created without an explicit source default to `"user"`.
 *   - Conversations seeded with a non-default source (e.g. `"auto-analysis"`)
 *     are returned with that value reflected verbatim.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
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

import { createConversation } from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";

initializeDb();

type ConversationSummary = {
  id: string;
  title: string;
  source: string;
  conversationType: string;
};

describe("GET /v1/conversations includes source discriminator", () => {
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

  test("returns source for every listed conversation", async () => {
    createConversation("First conversation");
    createConversation("Second conversation");
    await startServer();

    const response = await fetch(url("/conversations"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      conversations: ConversationSummary[];
    };
    expect(body.conversations.length).toBeGreaterThanOrEqual(2);
    for (const conversation of body.conversations) {
      expect(typeof conversation.source).toBe("string");
      expect(conversation.source.length).toBeGreaterThan(0);
    }
  });

  test('defaults source to "user" for conversations created without an explicit source', async () => {
    const created = createConversation("Default-source conversation");
    await startServer();

    const response = await fetch(url("/conversations"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      conversations: ConversationSummary[];
    };
    const listed = body.conversations.find((item) => item.id === created.id);
    expect(listed).toBeDefined();
    expect(listed?.source).toBe("user");
  });

  test('reflects a custom source (e.g. "auto-analysis") verbatim', async () => {
    const created = createConversation({
      title: "Auto-analysis conversation",
      source: "auto-analysis",
    });
    await startServer();

    const response = await fetch(url("/conversations"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      conversations: ConversationSummary[];
    };
    const listed = body.conversations.find((item) => item.id === created.id);
    expect(listed).toBeDefined();
    expect(listed?.source).toBe("auto-analysis");
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
