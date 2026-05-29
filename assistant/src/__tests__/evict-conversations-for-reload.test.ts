/**
 * Contract test for `DaemonServer.evictConversationsForReload`.
 *
 * Standing up a full DaemonServer is impractical (heavy collaborator graph),
 * so this test mirrors the eviction logic from server.ts and verifies that
 * `shouldProtect` is respected — conversations with active subagents are
 * marked stale instead of evicted.
 *
 * Regression guard for LUM-2039: subagent spawn silent death caused by
 * config-reload eviction bypassing the shouldProtect callback.
 */
import { describe, expect, test } from "bun:test";

interface MockConversation {
  processing: boolean;
  stale: boolean;
  disposed: boolean;
  isProcessing(): boolean;
  markStale(): void;
  dispose(): void;
}

function createMockConversation(processing = false): MockConversation {
  return {
    processing,
    stale: false,
    disposed: false,
    isProcessing() {
      return this.processing;
    },
    markStale() {
      this.stale = true;
    },
    dispose() {
      this.disposed = true;
    },
  };
}

/**
 * Mirrors the eviction logic from `DaemonServer.evictConversationsForReload`
 * in server.ts. The production code iterates conversations and checks both
 * `isProcessing()` and `shouldProtect()` before evicting.
 */
function evictConversationsForReload(
  conversations: Map<string, MockConversation>,
  shouldProtect: (id: string) => boolean,
): { evicted: string[]; staled: string[] } {
  const evicted: string[] = [];
  const staled: string[] = [];

  for (const [id, conversation] of conversations) {
    if (!conversation.isProcessing() && !shouldProtect(id)) {
      conversation.dispose();
      conversations.delete(id);
      evicted.push(id);
    } else {
      conversation.markStale();
      staled.push(id);
    }
  }

  return { evicted, staled };
}

describe("evictConversationsForReload — shouldProtect contract", () => {
  test("evicts idle conversations without active subagents", () => {
    const conversations = new Map<string, MockConversation>();
    conversations.set("idle-1", createMockConversation());
    conversations.set("idle-2", createMockConversation());

    const { evicted, staled } = evictConversationsForReload(
      conversations,
      () => false,
    );

    expect(evicted).toEqual(["idle-1", "idle-2"]);
    expect(staled).toEqual([]);
    expect(conversations.size).toBe(0);
  });

  test("marks stale instead of evicting when shouldProtect returns true", () => {
    const conversations = new Map<string, MockConversation>();
    const parentConv = createMockConversation();
    const idleConv = createMockConversation();
    conversations.set("parent-with-subagent", parentConv);
    conversations.set("idle-no-children", idleConv);

    const { evicted, staled } = evictConversationsForReload(
      conversations,
      (id) => id === "parent-with-subagent",
    );

    expect(evicted).toEqual(["idle-no-children"]);
    expect(staled).toEqual(["parent-with-subagent"]);
    expect(parentConv.disposed).toBe(false);
    expect(parentConv.stale).toBe(true);
    expect(idleConv.disposed).toBe(true);
    expect(conversations.has("parent-with-subagent")).toBe(true);
    expect(conversations.has("idle-no-children")).toBe(false);
  });

  test("marks stale when conversation is processing (regardless of protection)", () => {
    const conversations = new Map<string, MockConversation>();
    const processing = createMockConversation(true);
    conversations.set("busy", processing);

    const { evicted, staled } = evictConversationsForReload(
      conversations,
      () => false,
    );

    expect(evicted).toEqual([]);
    expect(staled).toEqual(["busy"]);
    expect(processing.disposed).toBe(false);
    expect(processing.stale).toBe(true);
  });

  test("marks stale when both processing and protected", () => {
    const conversations = new Map<string, MockConversation>();
    const conv = createMockConversation(true);
    conversations.set("busy-parent", conv);

    const { evicted, staled } = evictConversationsForReload(
      conversations,
      () => true,
    );

    expect(evicted).toEqual([]);
    expect(staled).toEqual(["busy-parent"]);
    expect(conv.disposed).toBe(false);
  });
});
