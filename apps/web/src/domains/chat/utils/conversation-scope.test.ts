import { describe, expect, test } from "bun:test";

import { isAsyncChatScopeCurrent } from "@/domains/chat/utils/conversation-scope";

describe("isAsyncChatScopeCurrent", () => {
  test("matches the original conversation key", () => {
    expect(
      isAsyncChatScopeCurrent({
        currentAssistantId: "assistant-1",
        currentConversationId: "draft-1",
        requestAssistantId: "assistant-1",
        requestConversationId: "draft-1",
        resolvedConversationId: "server-1",
      }),
    ).toBe(true);
  });

  test("matches the resolved conversation key after draft resolution", () => {
    expect(
      isAsyncChatScopeCurrent({
        currentAssistantId: "assistant-1",
        currentConversationId: "server-1",
        requestAssistantId: "assistant-1",
        requestConversationId: "draft-1",
        resolvedConversationId: "server-1",
      }),
    ).toBe(true);
  });

  test("rejects a different active conversation", () => {
    expect(
      isAsyncChatScopeCurrent({
        currentAssistantId: "assistant-1",
        currentConversationId: "weather-chat",
        requestAssistantId: "assistant-1",
        requestConversationId: "blog-chat",
        resolvedConversationId: "blog-chat",
      }),
    ).toBe(false);
  });

  test("rejects a different assistant", () => {
    expect(
      isAsyncChatScopeCurrent({
        currentAssistantId: "assistant-2",
        currentConversationId: "chat-1",
        requestAssistantId: "assistant-1",
        requestConversationId: "chat-1",
      }),
    ).toBe(false);
  });
});
