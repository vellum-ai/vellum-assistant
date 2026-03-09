import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { MessagingProvider } from "../messaging/provider.js";
import type { SendOptions } from "../messaging/provider-types.js";

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
    token: string,
    conversationId: string,
    text: string,
    options?: SendOptions,
  ) => sendMessageMock(token, conversationId, text, options),
};

mock.module("../config/bundled-skills/messaging/tools/shared.js", () => ({
  resolveProvider: () => provider,
  withProviderToken: async (
    _provider: MessagingProvider,
    fn: (token: string) => Promise<unknown>,
  ) => fn("provider-token"),
  ok: (content: string) => ({ content, isError: false }),
  err: (content: string) => ({ content, isError: true }),
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
        sessionId: "sess-1",
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
        assistantId: "ast-alpha",
      },
    );
  });
});
