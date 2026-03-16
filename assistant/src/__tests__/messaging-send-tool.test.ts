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
    connectionOrToken: OAuthConnection | string,
    conversationId: string,
    text: string,
    options?: SendOptions,
  ) => sendMessageMock(connectionOrToken, conversationId, text, options),
};

mock.module("../config/bundled-skills/messaging/tools/shared.js", () => ({
  resolveProvider: () => provider,
  getProviderConnection: () => "provider-token",
  ok: (content: string) => ({ content, isError: false }),
  err: (content: string) => ({ content, isError: true }),
  extractHeader: () => "",
  parseAddressList: () => [],
  extractEmail: (a: string) => a.toLowerCase(),
}));

import { run } from "../config/bundled-skills/messaging/tools/messaging-send.js";

describe("messaging-send tool", () => {
  beforeEach(() => {
    sendMessageMock.mockClear();
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
      "provider-token",
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
      "provider-token",
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
});
