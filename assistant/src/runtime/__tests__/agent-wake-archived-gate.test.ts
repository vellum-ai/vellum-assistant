/**
 * The `sidebar-done` gate on the wake's archived-conversation rejection.
 *
 * `defaultResolveTarget` is module-private, so it is exercised through
 * `wakeAgentForOpportunity()` called without explicit deps. The hydrate step
 * after the archived check is stubbed to throw, which the resolver catches
 * and reports as `not_found` — a flag-on result of `not_found` therefore
 * proves the wake got PAST the archived check and tried to hydrate, while a
 * result of `archived` proves it did not.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let sidebarDoneEnabled = false;
mock.module("../../config/sidebar-done-gate.js", () => ({
  SIDEBAR_DONE_FLAG_KEY: "sidebar-done",
  isSidebarDoneEnabled: () => sidebarDoneEnabled,
}));

const ARCHIVED_CONVERSATION_ID = "conv-archived-wake";

const getConversationMock = mock((id: string) =>
  id === ARCHIVED_CONVERSATION_ID
    ? { id, archivedAt: 1_700_000_000_000 }
    : undefined,
);
const actualCrud = await import("../../persistence/conversation-crud.js");
mock.module("../../persistence/conversation-crud.js", () => ({
  ...actualCrud,
  getConversation: getConversationMock,
}));

const getOrCreateConversationMock = mock(async () => {
  throw new Error("hydrate stub");
});
const actualStore = await import("../../daemon/conversation-store.js");
mock.module("../../daemon/conversation-store.js", () => ({
  ...actualStore,
  getOrCreateConversation: getOrCreateConversationMock,
}));

import { wakeAgentForOpportunity } from "../agent-wake.js";

describe("agent-wake archived conversations under sidebar-done", () => {
  beforeEach(() => {
    getConversationMock.mockClear();
    getOrCreateConversationMock.mockClear();
  });

  test("rejects the wake with reason archived when the flag is off", async () => {
    sidebarDoneEnabled = false;

    const result = await wakeAgentForOpportunity({
      conversationId: ARCHIVED_CONVERSATION_ID,
      hint: "scheduled run",
      source: "schedule",
    });

    expect(result.invoked).toBe(false);
    expect(result.reason).toBe("archived");
    expect(getOrCreateConversationMock).not.toHaveBeenCalled();
  });

  test("proceeds past the archived check when the flag is on", async () => {
    sidebarDoneEnabled = true;

    const result = await wakeAgentForOpportunity({
      conversationId: ARCHIVED_CONVERSATION_ID,
      hint: "scheduled run",
      source: "schedule",
    });

    expect(result.reason).not.toBe("archived");
    expect(getOrCreateConversationMock).toHaveBeenCalledTimes(1);
  });

  test("still reports not_found for a conversation that does not exist", async () => {
    sidebarDoneEnabled = true;

    const result = await wakeAgentForOpportunity({
      conversationId: "conv-missing",
      hint: "scheduled run",
      source: "schedule",
    });

    expect(result.invoked).toBe(false);
    expect(result.reason).toBe("not_found");
    expect(getOrCreateConversationMock).not.toHaveBeenCalled();
  });
});
