import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { MessagingProvider } from "../messaging/provider.js";
import type { SendOptions } from "../messaging/provider-types.js";
import type { OAuthConnection } from "../oauth/connection.js";

const sendMessageMock = mock(async (..._args: unknown[]) => ({
  id: "msg-1",
  timestamp: 123,
  conversationId: "conv-1",
}));

const provider: MessagingProvider = {
  id: "phone",
  displayName: "Phone",
  credentialService: "twilio",
  capabilities: new Set(["send"]),
  testConnection: async () => ({
    connected: true,
    user: "x",
    platform: "phone",
  }),
  listConversations: async () => [],
  getHistory: async () => [],
  search: async () => ({ total: 0, messages: [], hasMore: false }),
  sendMessage: (
    connection: OAuthConnection | undefined,
    conversationId: string,
    text: string,
    options?: SendOptions,
  ) => sendMessageMock(connection, conversationId, text, options),
};

mock.module("../config/bundled-skills/messaging/tools/shared.js", () => ({
  resolveProvider: () => provider,
  getProviderConnection: () => undefined,
  ok: (content: string) => ({ content, isError: false }),
  err: (content: string) => ({ content, isError: true }),
  extractHeader: () => "",
  parseAddressList: () => [],
  extractEmail: (a: string) => a.toLowerCase(),
}));

// ── Cross-post dependency mocks ──

const addMessageMock = mock(
  async (
    conversationId: string,
    role: string,
    content: string,
    _metadata?: Record<string, unknown>,
    _opts?: { skipIndexing?: boolean },
  ) => ({
    id: "xpost-msg-1",
    conversationId,
    role,
    content,
    createdAt: Date.now(),
  }),
);

const getConversationMock = mock(
  (_id: string) => null as { id: string; createdAt: number } | null,
);

const syncMessageToDiskMock = mock(
  (
    _conversationId: string,
    _messageId: string,
    _createdAtMs: number,
  ) => {},
);

const getBindingByChannelChatMock = mock(
  (_sourceChannel: string, _externalChatId: string) =>
    null as { conversationId: string; sourceChannel: string; externalChatId: string } | null,
);

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: addMessageMock,
  getConversation: getConversationMock,
}));

mock.module("../memory/conversation-disk-view.js", () => ({
  syncMessageToDisk: syncMessageToDiskMock,
}));

mock.module("../memory/external-conversation-store.js", () => ({
  getBindingByChannelChat: getBindingByChannelChatMock,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { run } from "../config/bundled-skills/messaging/tools/messaging-send.js";

describe("messaging-send tool", () => {
  beforeEach(() => {
    sendMessageMock.mockClear();
    addMessageMock.mockClear();
    getConversationMock.mockClear();
    syncMessageToDiskMock.mockClear();
    getBindingByChannelChatMock.mockClear();
  });

  test("passes assistantId from tool context to provider send options", async () => {
    const result = await run(
      {
        platform: "phone",
        conversation_id: "+15550004444",
        text: "test message",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-1",
        assistantId: "ast-alpha",
        trustClass: "guardian" as const,
      },
    );

    expect(result.isError).toBe(false);
    expect(sendMessageMock).toHaveBeenCalledWith(
      undefined,
      "+15550004444",
      "test message",
      {
        subject: undefined,
        inReplyTo: undefined,
        threadId: undefined,
        assistantId: "ast-alpha",
      },
    );
  });

  test("passes threadId to provider when replying on non-Gmail platform", async () => {
    const result = await run(
      {
        platform: "phone",
        conversation_id: "conv-1",
        text: "reply text",
        thread_id: "thread-abc",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-1",
        assistantId: "ast-alpha",
        trustClass: "guardian" as const,
      },
    );

    expect(result.isError).toBe(false);
    expect(sendMessageMock).toHaveBeenCalledWith(
      undefined,
      "conv-1",
      "reply text",
      {
        subject: undefined,
        inReplyTo: undefined,
        threadId: "thread-abc",
        assistantId: "ast-alpha",
      },
    );
  });

  test("cross-posts outbound message to bound conversation", async () => {
    getBindingByChannelChatMock.mockImplementation(() => ({
      conversationId: "bound-conv-99",
      sourceChannel: "phone",
      externalChatId: "+15550004444",
    }));
    getConversationMock.mockImplementation(() => ({
      id: "bound-conv-99",
      createdAt: 1700000000000,
    }));

    const result = await run(
      {
        platform: "phone",
        conversation_id: "+15550004444",
        text: "hello from A",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-A",
        assistantId: "ast-1",
        trustClass: "guardian" as const,
      },
    );

    expect(result.isError).toBe(false);
    expect(addMessageMock).toHaveBeenCalledWith(
      "bound-conv-99",
      "assistant",
      JSON.stringify([{ type: "text", text: "hello from A" }]),
      { automated: true, crossPostedFrom: "conv-A" },
      { skipIndexing: true },
    );
    expect(syncMessageToDiskMock).toHaveBeenCalledWith(
      "bound-conv-99",
      "xpost-msg-1",
      1700000000000,
    );
  });

  test("does not cross-post when bound conversation is the sender", async () => {
    getBindingByChannelChatMock.mockImplementation(() => ({
      conversationId: "conv-A",
      sourceChannel: "phone",
      externalChatId: "+15550004444",
    }));

    await run(
      {
        platform: "phone",
        conversation_id: "+15550004444",
        text: "hello",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-A",
        assistantId: "ast-1",
        trustClass: "guardian" as const,
      },
    );

    expect(addMessageMock).not.toHaveBeenCalled();
  });

  test("does not cross-post when no binding exists", async () => {
    getBindingByChannelChatMock.mockImplementation(() => null);

    await run(
      {
        platform: "phone",
        conversation_id: "+15550004444",
        text: "hello",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-A",
        assistantId: "ast-1",
        trustClass: "guardian" as const,
      },
    );

    expect(addMessageMock).not.toHaveBeenCalled();
  });

  test("cross-post failure does not fail the send", async () => {
    getBindingByChannelChatMock.mockImplementation(() => ({
      conversationId: "bound-conv-99",
      sourceChannel: "phone",
      externalChatId: "+15550004444",
    }));
    getConversationMock.mockImplementation(() => ({
      id: "bound-conv-99",
      createdAt: 1700000000000,
    }));
    addMessageMock.mockImplementation(async () => {
      throw new Error("DB write failed");
    });

    const result = await run(
      {
        platform: "phone",
        conversation_id: "+15550004444",
        text: "hello",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-A",
        assistantId: "ast-1",
        trustClass: "guardian" as const,
      },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Message sent");
  });

  test("does not cross-post when bound conversation no longer exists", async () => {
    getBindingByChannelChatMock.mockImplementation(() => ({
      conversationId: "deleted-conv",
      sourceChannel: "phone",
      externalChatId: "+15550004444",
    }));
    getConversationMock.mockImplementation(() => null);

    await run(
      {
        platform: "phone",
        conversation_id: "+15550004444",
        text: "hello",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-A",
        assistantId: "ast-1",
        trustClass: "guardian" as const,
      },
    );

    expect(getBindingByChannelChatMock).toHaveBeenCalled();
    expect(addMessageMock).not.toHaveBeenCalled();
  });
});
