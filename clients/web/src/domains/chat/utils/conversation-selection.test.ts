import { describe, expect, test } from "bun:test";

import {
  createDraftConversationId,
  resolveBootstrappedConversationId,
  shouldMintNewChatDraft,
} from "@/domains/chat/utils/conversation-selection";
import { useConversationStore } from "@/stores/conversation-store";

/** The last-viewed row as the server returns it, still a foreground chat. */
const OLD_VISIBLE = { conversationId: "old-visible" };

describe("resolveBootstrappedConversationId", () => {
  test("uses the explicit URL conversation key first", () => {
    expect(
      resolveBootstrappedConversationId({
        queryParamKey: "from-url",
        onboardingDraftConversationId: "onboarding-draft",
        currentConversationId: "current",
        currentAssistantId: "asst-1",
        nextAssistantId: "asst-1",
        storedConversation: { conversationId: "stored" },
        defaultConversationId: "new-latest",
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
        storedConversation: OLD_VISIBLE,
        defaultConversationId: "new-latest",
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
        storedConversation: null,
        defaultConversationId: "new-latest",
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
        storedConversation: null,
        defaultConversationId: "new-latest",
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
        storedConversation: OLD_VISIBLE,
        defaultConversationId: "new-latest",
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
        storedConversation: {
          conversationId: "heartbeat",
          conversationType: "background",
        },
        defaultConversationId: "asst-1",
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
        storedConversation: {
          conversationId: "surfaced-bg",
          conversationType: "background",
          surfacedAt: 1704067200000,
        },
        defaultConversationId: "new-latest",
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
        storedConversation: {
          conversationId: "surfaced-sched",
          groupId: "system:scheduled",
          surfacedAt: 1704067200000,
        },
        defaultConversationId: "new-latest",
      }),
    ).toBe("surfaced-sched");
  });

  test("falls to the default when the stored conversation is gone", () => {
    /* The by-id lookup answered 404, so there is no row to resume. */
    expect(
      resolveBootstrappedConversationId({
        queryParamKey: null,
        currentConversationId: null,
        currentAssistantId: null,
        nextAssistantId: "asst-1",
        storedConversation: null,
        defaultConversationId: "new-latest",
      }),
    ).toBe("new-latest");
  });

  describe("newChatDraftConversationId", () => {
    test("replaces both resume fallbacks on cold load", () => {
      expect(
        resolveBootstrappedConversationId({
          queryParamKey: null,
          newChatDraftConversationId: "new-chat-draft",
          currentConversationId: null,
          currentAssistantId: null,
          nextAssistantId: "asst-1",
          storedConversation: OLD_VISIBLE,
          defaultConversationId: "new-latest",
        }),
      ).toBe("new-chat-draft");
    });

    test("loses to an explicit URL conversation key", () => {
      expect(
        resolveBootstrappedConversationId({
          queryParamKey: "from-url",
          newChatDraftConversationId: "new-chat-draft",
          currentConversationId: null,
          currentAssistantId: null,
          nextAssistantId: "asst-1",
          storedConversation: OLD_VISIBLE,
          defaultConversationId: "new-latest",
        }),
      ).toBe("from-url");
    });

    test("loses to the onboarding draft", () => {
      expect(
        resolveBootstrappedConversationId({
          queryParamKey: null,
          onboardingDraftConversationId: "onboarding-draft",
          newChatDraftConversationId: "new-chat-draft",
          currentConversationId: null,
          currentAssistantId: null,
          nextAssistantId: "asst-1",
          storedConversation: OLD_VISIBLE,
          defaultConversationId: "new-latest",
        }),
      ).toBe("onboarding-draft");
    });

    test("loses to an existing same-assistant in-memory selection", () => {
      expect(
        resolveBootstrappedConversationId({
          queryParamKey: null,
          newChatDraftConversationId: "new-chat-draft",
          currentConversationId: "old-visible",
          currentAssistantId: "asst-1",
          nextAssistantId: "asst-1",
          storedConversation: OLD_VISIBLE,
          defaultConversationId: "new-latest",
        }),
      ).toBe("old-visible");
    });

    test("leaves cold-load resume unchanged when absent or null", () => {
      const args = {
        queryParamKey: null,
        currentConversationId: null,
        currentAssistantId: null,
        nextAssistantId: "asst-1",
        storedConversation: OLD_VISIBLE,
        defaultConversationId: "new-latest",
      };
      expect(resolveBootstrappedConversationId(args)).toBe("old-visible");
      expect(
        resolveBootstrappedConversationId({
          ...args,
          newChatDraftConversationId: null,
        }),
      ).toBe("old-visible");
    });

    test("resolves the same key with or without a stored row", () => {
      const args = {
        queryParamKey: null,
        newChatDraftConversationId: "new-chat-draft",
        currentConversationId: null,
        currentAssistantId: null,
        nextAssistantId: "asst-1",
        defaultConversationId: "new-latest",
      };
      // The draft short-circuits both server-backed fallbacks, so the loader
      // can land on it without asking the server anything.
      expect(
        resolveBootstrappedConversationId({
          ...args,
          storedConversation: null,
        }),
      ).toBe("new-chat-draft");
      expect(
        resolveBootstrappedConversationId({
          ...args,
          storedConversation: OLD_VISIBLE,
        }),
      ).toBe("new-chat-draft");
    });
  });
});

describe("shouldMintNewChatDraft", () => {
  test("mints while nothing is selected in the URL or the store", () => {
    expect(
      shouldMintNewChatDraft({
        platformStartsInNewChat: true,
        urlConversationId: null,
        currentConversationId: null,
      }),
    ).toBe(true);
  });

  test("withholds the draft when the URL already names a conversation", () => {
    expect(
      shouldMintNewChatDraft({
        platformStartsInNewChat: true,
        urlConversationId: "from-deep-link",
        currentConversationId: null,
      }),
    ).toBe(false);
  });

  test("withholds the draft when a conversation is already selected", () => {
    expect(
      shouldMintNewChatDraft({
        platformStartsInNewChat: true,
        urlConversationId: null,
        currentConversationId: "already-sent-draft",
      }),
    ).toBe(false);
  });

  test("does not mint when the platform does not start in a new chat", () => {
    expect(
      shouldMintNewChatDraft({
        platformStartsInNewChat: false,
        urlConversationId: null,
        currentConversationId: null,
      }),
    ).toBe(false);
  });
});

describe("createDraftConversationId", () => {
  test("registers the minted key as a draft", () => {
    useConversationStore.getState().reset();

    const conversationId = createDraftConversationId();

    expect(
      useConversationStore.getState().draftConversationIds.has(conversationId),
    ).toBe(true);
  });

  test("registers every key it mints, so concurrent drafts both count", () => {
    useConversationStore.getState().reset();

    const first = createDraftConversationId();
    const second = createDraftConversationId();

    expect(first).not.toBe(second);
    expect(useConversationStore.getState().draftConversationIds).toEqual(
      new Set([first, second]),
    );
  });
});
