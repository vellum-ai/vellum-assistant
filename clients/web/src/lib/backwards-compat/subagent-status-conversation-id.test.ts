import { beforeEach, describe, expect, test } from "bun:test";

import { legacySubagentStatusParentConversationId } from "@/lib/backwards-compat/subagent-status-conversation-id";
import { useConversationStore } from "@/stores/conversation-store";

beforeEach(() => {
  useConversationStore.getState().setActiveConversationId(null);
});

describe("legacySubagentStatusParentConversationId", () => {
  test("names the conversation on screen", () => {
    useConversationStore.getState().setActiveConversationId("conv-active");

    expect(legacySubagentStatusParentConversationId()).toBe("conv-active");
  });

  test("names nothing with no conversation on screen", () => {
    expect(legacySubagentStatusParentConversationId()).toBeUndefined();
  });
});
