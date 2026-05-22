import { describe, expect, test } from "bun:test";

import {
  ConversationClient,
  getEffectiveOriginChannel,
  isExternalChannelReadOnly,
  type ConversationSummary,
} from "../lib/conversation-client.js";

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    return makeJsonResponse({ ok: true, conversations: [], messages: [] });
  };

  const client = new ConversationClient({
    baseUrl: "https://runtime.example.com/",
    assistantId: "assistant-123",
    auth: { Authorization: "Bearer token" },
    fetchImpl: fetchImpl as typeof fetch,
  });

  return { client, calls };
}

function lastJsonBody(calls: Array<{ init: RequestInit }>): unknown {
  const body = calls[calls.length - 1]?.init.body;
  expect(typeof body).toBe("string");
  return JSON.parse(body as string);
}

describe("ConversationClient", () => {
  test("builds event URLs with conversationId", () => {
    const { client } = makeClient();

    expect(client.buildEventsUrl("conv-123")).toBe(
      "https://runtime.example.com/v1/assistants/assistant-123/events?conversationId=conv-123",
    );
  });

  test("sends messages with conversationId, not conversationKey", async () => {
    const { client, calls } = makeClient();

    await client.sendMessage({
      conversationId: "conv-123",
      content: "hello",
      clientMessageId: "client-message-1",
    });

    expect(calls[0].url).toBe(
      "https://runtime.example.com/v1/assistants/assistant-123/messages",
    );
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    });
    expect(lastJsonBody(calls)).toEqual({
      conversationId: "conv-123",
      content: "hello",
      sourceChannel: "vellum",
      interface: "cli",
      clientMessageId: "client-message-1",
    });
  });

  test("runs btw with conversationId, not conversationKey", async () => {
    const { client, calls } = makeClient();

    await client.runBtw({ conversationId: "conv-123", content: "side note" });

    expect(calls[0].url).toBe(
      "https://runtime.example.com/v1/assistants/assistant-123/btw",
    );
    expect(calls[0].init.headers).toMatchObject({
      Accept: "text/event-stream",
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    });
    expect(lastJsonBody(calls)).toEqual({
      conversationId: "conv-123",
      content: "side note",
    });
  });

  test("lists messages by conversationId", async () => {
    const { client, calls } = makeClient();

    await client.listMessages("conv-123", {
      page: "latest",
      limit: 50,
      beforeTimestamp: 123456,
    });

    expect(calls[0].url).toBe(
      "https://runtime.example.com/v1/assistants/assistant-123/messages?conversationId=conv-123&limit=50&page=latest&beforeTimestamp=123456",
    );
    expect(calls[0].init.method).toBe("GET");
  });

  test("switches conversations without sending a conversationKey", async () => {
    const { client, calls } = makeClient();

    await client.switchConversation("conv-123");

    expect(calls[0].url).toBe(
      "https://runtime.example.com/v1/assistants/assistant-123/conversations/switch",
    );
    expect(lastJsonBody(calls)).toEqual({ conversationId: "conv-123" });
  });

  test("creates conversations without client-side conversation keys", async () => {
    const { client, calls } = makeClient();

    await client.createConversation();

    expect(calls[0].url).toBe(
      "https://runtime.example.com/v1/assistants/assistant-123/conversations",
    );
    expect(lastJsonBody(calls)).toEqual({});
  });

  test("searches conversations with encoded query params", async () => {
    const { client, calls } = makeClient();

    await client.searchConversations({
      query: "hello world",
      limit: 10,
      maxMessagesPerConversation: 2,
    });

    expect(calls[0].url).toBe(
      "https://runtime.example.com/v1/assistants/assistant-123/conversations/search?q=hello+world&limit=10&maxMessagesPerConversation=2",
    );
  });
});

describe("conversation origin helpers", () => {
  function summary(
    conversation: Partial<ConversationSummary>,
  ): ConversationSummary {
    return { id: "conv-123", ...conversation };
  }

  test("prefers channelBinding.sourceChannel over conversationOriginChannel", () => {
    expect(
      getEffectiveOriginChannel(
        summary({
          channelBinding: { sourceChannel: "slack" },
          conversationOriginChannel: "vellum",
        }),
      ),
    ).toBe("slack");
  });

  test("treats absent, vellum, and notification origins as writable", () => {
    expect(isExternalChannelReadOnly(summary({}))).toBe(false);
    expect(
      isExternalChannelReadOnly(
        summary({ conversationOriginChannel: "vellum" }),
      ),
    ).toBe(false);
    expect(
      isExternalChannelReadOnly(
        summary({ conversationOriginChannel: "notification:daily" }),
      ),
    ).toBe(false);
  });

  test("treats external origins as read-only", () => {
    for (const channel of ["slack", "telegram", "phone", "email", "whatsapp"]) {
      expect(
        isExternalChannelReadOnly(
          summary({ conversationOriginChannel: channel }),
        ),
      ).toBe(true);
    }
  });

  test("ignores conversationOriginInterface for writeability", () => {
    expect(
      isExternalChannelReadOnly(
        summary({
          conversationOriginChannel: "vellum",
          conversationOriginInterface: "slack",
        }),
      ),
    ).toBe(false);
  });
});
