/**
 * `evictConversationsForReload` drops in-memory conversations after a
 * config/prompt reload so the next turn rebuilds them against the new
 * config. A deferred send is registered against the instance being disposed,
 * so the same "not idle while a send is waiting" rule the periodic evictor
 * applies has to hold here: `isProcessing()` reads false in the window
 * between a turn releasing and its deferred successor being dispatched.
 *
 * In-flight subagents and resident mode-session state are other non-idle
 * cases. Reload marks the conversation stale without discarding that state,
 * then `getOrCreateConversation` rebuilds it once every retained lifecycle is
 * settled.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const abortedParents: string[] = [];
const activeParents = new Set<string>();

mock.module("../subagent/index.js", () => ({
  getSubagentManager: () => ({
    abortAllForParent: (id: string) => {
      abortedParents.push(id);
    },
    getChildrenOf: () => [],
    hasActiveChildren: (id: string) => activeParents.has(id),
  }),
}));

import { Conversation } from "../daemon/conversation.js";
import {
  clearConversations,
  conversationIds,
  findConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import {
  evictConversationsForReload,
  getOrCreateConversation,
} from "../daemon/conversation-store.js";

interface FakeConversation {
  disposed: boolean;
  markedStale: boolean;
}

function register(
  id: string,
  state: {
    processing: boolean;
    deferred: boolean;
    modeSessionWork?: boolean;
    stale?: boolean;
  },
): FakeConversation {
  const fake: FakeConversation & Record<string, unknown> = {
    disposed: false,
    markedStale: false,
    conversationId: id,
    liveVoiceResidencyLeases: 0,
    isProcessing: () => state.processing,
    hasPendingDeferredSends: () => state.deferred,
    modeSessions: {
      hasResidentWork: () => state.modeSessionWork === true,
    },
    isStale: () => state.stale === true || fake.markedStale,
    hasInFlightWork() {
      return Conversation.prototype.hasInFlightWork.call(
        fake as unknown as Conversation,
      );
    },
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
    abortedParents.length = 0;
    activeParents.clear();
  });

  test("disposes an idle conversation", () => {
    const idle = register("reload-idle", {
      processing: false,
      deferred: false,
    });

    evictConversationsForReload();

    expect(idle.disposed).toBe(true);
    expect(findConversation("reload-idle")).toBeUndefined();
    expect(abortedParents).toEqual(["reload-idle"]);
  });

  test("keeps a conversation with a deferred send and marks it stale", () => {
    const deferred = register("reload-deferred", {
      processing: false,
      deferred: true,
    });

    evictConversationsForReload();

    // Disposing here would run the deferred send against a conversation whose
    // state is already gone.
    expect(deferred.disposed).toBe(false);
    expect(deferred.markedStale).toBe(true);
    expect(findConversation("reload-deferred")).toBeDefined();
    expect(abortedParents).toEqual([]);
  });

  test("marks a mid-turn conversation stale instead of disposing it", () => {
    const busy = register("reload-busy", { processing: true, deferred: false });

    evictConversationsForReload();

    expect(busy.disposed).toBe(false);
    expect(busy.markedStale).toBe(true);
    expect([...conversationIds()]).toEqual(["reload-busy"]);
    expect(abortedParents).toEqual([]);
  });

  test("marks an idle parent with in-flight subagents stale", () => {
    const parent = register("reload-with-children", {
      processing: false,
      deferred: false,
    });
    activeParents.add("reload-with-children");

    evictConversationsForReload();

    expect(parent.disposed).toBe(false);
    expect(parent.markedStale).toBe(true);
    expect(findConversation("reload-with-children")).toBeDefined();
    expect(abortedParents).toEqual([]);
  });

  test("keeps resident mode-session ownership usable across reload eviction", () => {
    const resident = register("reload-mode-active", {
      processing: false,
      deferred: false,
      modeSessionWork: true,
    });

    evictConversationsForReload();

    expect(resident.disposed).toBe(false);
    expect(resident.markedStale).toBe(true);
    expect(findConversation("reload-mode-active")).toBeDefined();
    expect(abortedParents).toEqual([]);
  });

  test("keeps a Live voice residency lease until the socket releases it", () => {
    const resident = register("reload-live-voice", {
      processing: false,
      deferred: false,
    });
    const release = Conversation.prototype.acquireLiveVoiceResidency.call(
      resident as unknown as Conversation,
    );

    evictConversationsForReload();

    expect(resident.disposed).toBe(false);
    expect(resident.markedStale).toBe(true);
    expect(findConversation("reload-live-voice")).toBeDefined();

    release();
    evictConversationsForReload();

    expect(resident.disposed).toBe(true);
    expect(findConversation("reload-live-voice")).toBeUndefined();
  });

  test("still evicts other idle conversations when one parent is protected", () => {
    const protectedParent = register("reload-protected", {
      processing: false,
      deferred: false,
    });
    const idle = register("reload-unprotected", {
      processing: false,
      deferred: false,
    });
    activeParents.add("reload-protected");

    evictConversationsForReload();

    expect(protectedParent.disposed).toBe(false);
    expect(protectedParent.markedStale).toBe(true);
    expect(findConversation("reload-protected")).toBeDefined();
    expect(idle.disposed).toBe(true);
    expect(findConversation("reload-unprotected")).toBeUndefined();
    expect(abortedParents).toEqual(["reload-unprotected"]);
  });

  test("defers stale rebuild while subagents are in flight", async () => {
    const parent = register("stale-parent", {
      processing: false,
      deferred: false,
      stale: true,
    });
    activeParents.add("stale-parent");

    const result = await getOrCreateConversation("stale-parent");

    expect(result as unknown).toBe(parent);
    expect(parent.disposed).toBe(false);
    expect(abortedParents).toEqual([]);
  });

  test("rebuilds a stale parent once every child is terminal", async () => {
    const parent = register("stale-parent", {
      processing: false,
      deferred: false,
      stale: true,
    });

    try {
      await getOrCreateConversation("stale-parent");
    } catch {
      // Isolated test has no provider wiring; rebuild intent is abort + dispose.
    }

    expect(parent.disposed).toBe(true);
    expect(abortedParents).toEqual(["stale-parent"]);
  });
});
