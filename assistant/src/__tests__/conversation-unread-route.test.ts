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

const mockMarkConversationUnread = mock((_conversationId: string) => true);

mock.module("../memory/conversation-attention-store.js", () => ({
  getAttentionStateByConversationIds: () => new Map(),
  recordConversationSeenSignal: () => ({}),
  markConversationUnread: mockMarkConversationUnread,
}));

mock.module("../memory/conversation-key-store.js", () => ({
  resolveConversationId: (id: string) => id,
}));

import { getPolicy } from "../runtime/auth/route-policy.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import { UserError } from "../util/errors.js";

describe("POST /v1/conversations/unread", () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeEach(() => {
    mockMarkConversationUnread.mockClear();
  });

  afterAll(async () => {
    await server?.stop();
  });

  async function startServer(): Promise<void> {
    port = 20000 + Math.floor(Math.random() * 1000);
    server = new RuntimeHttpServer({ port, bearerToken: "test-bearer-token" });
    await server.start();
  }

  async function stopServer(): Promise<void> {
    await server?.stop();
  }

  function unreadUrl(): string {
    return `http://127.0.0.1:${port}/v1/conversations/unread`;
  }

  test("registers the unread route with chat.write policy", () => {
    expect(getPolicy("conversations/unread")).toEqual({
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ["actor", "svc_gateway", "svc_daemon", "local"],
    });
  });

  test("returns BAD_REQUEST when conversationId is missing", async () => {
    await startServer();

    const res = await fetch(unreadUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Missing conversationId",
      },
    });
    expect(mockMarkConversationUnread).not.toHaveBeenCalled();

    await stopServer();
  });

  test("marks a conversation unread", async () => {
    await startServer();

    const res = await fetch(unreadUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "conv-123" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockMarkConversationUnread).toHaveBeenCalledTimes(1);
    expect(mockMarkConversationUnread).toHaveBeenCalledWith("conv-123");

    await stopServer();
  });

  test("returns UNPROCESSABLE_ENTITY when the conversation has no assistant message", async () => {
    mockMarkConversationUnread.mockImplementationOnce(() => {
      throw new UserError(
        "Conversation has no assistant message to mark unread",
      );
    });

    await startServer();

    const res = await fetch(unreadUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "conv-no-assistant" }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: {
        code: "UNPROCESSABLE_ENTITY",
        message: "Conversation has no assistant message to mark unread",
      },
    });

    await stopServer();
  });
});
