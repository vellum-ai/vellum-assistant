/**
 * `evictConversationsForReload` drops in-memory conversations after a
 * config/prompt/skills reload so the next turn rebuilds them against the new
 * config. Queued messages live only on the instance being disposed, so the
 * same "not idle while a queue is pending" rule the periodic evictor applies
 * has to hold here: `isProcessing()` reads false in the window between a turn
 * releasing and its queued successor being dispatched.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../subagent/index.js", () => ({
  getSubagentManager: () => ({
    abortAllForParent: () => {},
    getChildrenOf: () => [],
  }),
}));

import type { Conversation } from "../daemon/conversation.js";
import {
  clearConversations,
  conversationIds,
  findConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import { evictConversationsForReload } from "../daemon/conversation-store.js";

interface FakeConversation {
  disposed: boolean;
  markedStale: boolean;
}

function register(
  id: string,
  state: { processing: boolean; queued: boolean },
): FakeConversation {
  const fake: FakeConversation & Record<string, unknown> = {
    disposed: false,
    markedStale: false,
    conversationId: id,
    isProcessing: () => state.processing,
    hasQueuedMessages: () => state.queued,
    dispose() {
      fake.disposed = true;
    },
    markStale() {
      fake.markedStale = true;
    },
  };
  setConversation(id, fake as unknown as Conversation);
  return fake;
}

describe("evictConversationsForReload", () => {
  beforeEach(() => {
    clearConversations();
  });

  test("disposes an idle conversation", () => {
    const idle = register("reload-idle", { processing: false, queued: false });

    evictConversationsForReload();

    expect(idle.disposed).toBe(true);
    expect(findConversation("reload-idle")).toBeUndefined();
  });

  test("keeps a conversation with queued messages and marks it stale", () => {
    const queued = register("reload-queued", {
      processing: false,
      queued: true,
    });

    evictConversationsForReload();

    // Disposing here would silently destroy the in-memory queue.
    expect(queued.disposed).toBe(false);
    expect(queued.markedStale).toBe(true);
    expect(findConversation("reload-queued")).toBeDefined();
  });

  test("marks a mid-turn conversation stale instead of disposing it", () => {
    const busy = register("reload-busy", { processing: true, queued: false });

    evictConversationsForReload();

    expect(busy.disposed).toBe(false);
    expect(busy.markedStale).toBe(true);
    expect([...conversationIds()]).toEqual(["reload-busy"]);
  });
});
