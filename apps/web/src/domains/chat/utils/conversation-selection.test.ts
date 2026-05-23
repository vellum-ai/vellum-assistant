import { describe, expect, test } from "bun:test";

import { resolveBootstrappedConversationKey } from "@/domains/chat/utils/conversation-selection.js";

const conversations = [
  { conversationId: "old-visible" },
  { conversationId: "new-latest" },
];

describe("resolveBootstrappedConversationKey", () => {
  test("uses the explicit URL conversation key first", () => {
    expect(
      resolveBootstrappedConversationKey({
        queryParamKey: "from-url",
        onboardingDraftConversationKey: "onboarding-draft",
        currentConversationKey: "current",
        currentAssistantId: "asst-1",
        nextAssistantId: "asst-1",
        storedConversationKey: "stored",
        defaultConversationKey: "new-latest",
        conversations,
      }),
    ).toBe("from-url");
  });

  test("uses the onboarding draft before current, stored, or default keys", () => {
    expect(
      resolveBootstrappedConversationKey({
        queryParamKey: null,
        onboardingDraftConversationKey: "onboarding-draft",
        currentConversationKey: "current",
        currentAssistantId: "asst-1",
        nextAssistantId: "asst-1",
        storedConversationKey: "old-visible",
        defaultConversationKey: "new-latest",
        conversations,
      }),
    ).toBe("onboarding-draft");
  });

  test("preserves the current same-assistant conversation during refresh", () => {
    expect(
      resolveBootstrappedConversationKey({
        queryParamKey: null,
        currentConversationKey: "old-visible",
        currentAssistantId: "asst-1",
        nextAssistantId: "asst-1",
        storedConversationKey: null,
        defaultConversationKey: "new-latest",
        conversations,
      }),
    ).toBe("old-visible");
  });

  test("does not preserve a current key from a different assistant", () => {
    expect(
      resolveBootstrappedConversationKey({
        queryParamKey: null,
        currentConversationKey: "other-assistant-chat",
        currentAssistantId: "asst-2",
        nextAssistantId: "asst-1",
        storedConversationKey: null,
        defaultConversationKey: "new-latest",
        conversations,
      }),
    ).toBe("new-latest");
  });

  test("resumes a stored conversation on cold load when it still exists", () => {
    expect(
      resolveBootstrappedConversationKey({
        queryParamKey: null,
        currentConversationKey: null,
        currentAssistantId: null,
        nextAssistantId: "asst-1",
        storedConversationKey: "old-visible",
        defaultConversationKey: "new-latest",
        conversations,
      }),
    ).toBe("old-visible");
  });

  test("does not implicitly resume a stored background conversation", () => {
    expect(
      resolveBootstrappedConversationKey({
        queryParamKey: null,
        currentConversationKey: null,
        currentAssistantId: null,
        nextAssistantId: "asst-1",
        storedConversationKey: "heartbeat",
        defaultConversationKey: "asst-1",
        conversations: [
          { conversationId: "heartbeat", conversationType: "background" },
        ],
      }),
    ).toBe("asst-1");
  });

  test("ignores a stored conversation that is no longer in the list", () => {
    expect(
      resolveBootstrappedConversationKey({
        queryParamKey: null,
        currentConversationKey: null,
        currentAssistantId: null,
        nextAssistantId: "asst-1",
        storedConversationKey: "missing",
        defaultConversationKey: "new-latest",
        conversations,
      }),
    ).toBe("new-latest");
  });
});
