import { describe, expect, test } from "bun:test";

import { isAsyncChatScopeCurrent } from "@/domains/chat/utils/conversation-scope.js";

describe("isAsyncChatScopeCurrent", () => {
  test("matches the original conversation key", () => {
    expect(
      isAsyncChatScopeCurrent({
        currentAssistantId: "assistant-1",
        currentConversationKey: "draft-1",
        requestAssistantId: "assistant-1",
        requestConversationKey: "draft-1",
        resolvedConversationKey: "server-1",
      }),
    ).toBe(true);
  });

  test("matches the resolved conversation key after draft resolution", () => {
    expect(
      isAsyncChatScopeCurrent({
        currentAssistantId: "assistant-1",
        currentConversationKey: "server-1",
        requestAssistantId: "assistant-1",
        requestConversationKey: "draft-1",
        resolvedConversationKey: "server-1",
      }),
    ).toBe(true);
  });

  test("rejects a different active conversation", () => {
    expect(
      isAsyncChatScopeCurrent({
        currentAssistantId: "assistant-1",
        currentConversationKey: "weather-chat",
        requestAssistantId: "assistant-1",
        requestConversationKey: "blog-chat",
        resolvedConversationKey: "blog-chat",
      }),
    ).toBe(false);
  });

  test("rejects a different assistant", () => {
    expect(
      isAsyncChatScopeCurrent({
        currentAssistantId: "assistant-2",
        currentConversationKey: "chat-1",
        requestAssistantId: "assistant-1",
        requestConversationKey: "chat-1",
      }),
    ).toBe(false);
  });
});
