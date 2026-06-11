import { describe, expect, test } from "bun:test";

import { resolveBootstrappedConversationId } from "@/domains/chat/utils/conversation-selection";

const conversations = [
  { conversationId: "old-visible" },
  { conversationId: "new-latest" },
];

describe("resolveBootstrappedConversationId", () => {
  test("uses the explicit URL conversation key first", () => {
    expect(
      resolveBootstrappedConversationId({
        queryParamKey: "from-url",
        onboardingDraftConversationId: "onboarding-draft",
        currentConversationId: "current",
        currentAssistantId: "asst-1",
        nextAssistantId: "asst-1",
        storedConversationId: "stored",
        defaultConversationId: "new-latest",
        conversations,
      }),
    ).toBe("from-url");
  });

  test("uses the onboarding draft before current, stored, or default keys", () => {
    expect(
      resolveBootstrappedConversationId({
        queryParamKey: null,
        onboardingDraftConversationId: "onboarding-draft",
        currentConversationId: "current",
        currentAssistantId: "asst-1",
        nextAssistantId: "asst-1",
        storedConversationId: "old-visible",
        defaultConversationId: "new-latest",
        conversations,
      }),
    ).toBe("onboarding-draft");
  });

  test("preserves the current same-assistant conversation during refresh", () => {
    expect(
      resolveBootstrappedConversationId({
        queryParamKey: null,
        currentConversationId: "old-visible",
        currentAssistantId: "asst-1",
        nextAssistantId: "asst-1",
        storedConversationId: null,
        defaultConversationId: "new-latest",
        conversations,
      }),
    ).toBe("old-visible");
  });

  test("does not preserve a current key from a different assistant", () => {
    expect(
      resolveBootstrappedConversationId({
        queryParamKey: null,
        currentConversationId: "other-assistant-chat",
        currentAssistantId: "asst-2",
        nextAssistantId: "asst-1",
        storedConversationId: null,
        defaultConversationId: "new-latest",
        conversations,
      }),
    ).toBe("new-latest");
  });

  test("resumes a stored conversation on cold load when it still exists", () => {
    expect(
      resolveBootstrappedConversationId({
        queryParamKey: null,
        currentConversationId: null,
        currentAssistantId: null,
        nextAssistantId: "asst-1",
        storedConversationId: "old-visible",
        defaultConversationId: "new-latest",
        conversations,
      }),
    ).toBe("old-visible");
  });

  test("does not implicitly resume a stored background conversation", () => {
    expect(
      resolveBootstrappedConversationId({
        queryParamKey: null,
        currentConversationId: null,
        currentAssistantId: null,
        nextAssistantId: "asst-1",
        storedConversationId: "heartbeat",
        defaultConversationId: "asst-1",
        conversations: [
          { conversationId: "heartbeat", conversationType: "background" },
        ],
      }),
    ).toBe("asst-1");
  });

  test("resumes a stored surfaced background conversation on cold load", () => {
    expect(
      resolveBootstrappedConversationId({
        queryParamKey: null,
        currentConversationId: null,
        currentAssistantId: null,
        nextAssistantId: "asst-1",
        storedConversationId: "surfaced-bg",
        defaultConversationId: "new-latest",
        conversations: [
          {
            conversationId: "surfaced-bg",
            conversationType: "background",
            surfacedAt: 1704067200000,
          },
        ],
      }),
    ).toBe("surfaced-bg");
  });

  test("resumes a stored surfaced legacy-grouped conversation on cold load", () => {
    expect(
      resolveBootstrappedConversationId({
        queryParamKey: null,
        currentConversationId: null,
        currentAssistantId: null,
        nextAssistantId: "asst-1",
        storedConversationId: "surfaced-sched",
        defaultConversationId: "new-latest",
        conversations: [
          {
            conversationId: "surfaced-sched",
            groupId: "system:scheduled",
            surfacedAt: 1704067200000,
          },
        ],
      }),
    ).toBe("surfaced-sched");
  });

  test("ignores a stored conversation that is no longer in the list", () => {
    expect(
      resolveBootstrappedConversationId({
        queryParamKey: null,
        currentConversationId: null,
        currentAssistantId: null,
        nextAssistantId: "asst-1",
        storedConversationId: "missing",
        defaultConversationId: "new-latest",
        conversations,
      }),
    ).toBe("new-latest");
  });
});
