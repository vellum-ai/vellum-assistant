/**
 * Tests for GET /v1/conversations/:id/history endpoint.
 *
 * Validates paginated message retrieval, ordering, and cursor-based
 * pagination for cold-open hydration.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks ──────────────────────────────────────────────────────

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

/** In-memory message store for the fake DB layer. */
let dbMessages: Array<{
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
}> = [];

mock.module("../../../memory/conversation-crud.js", () => ({
  getMessagesPaginated: (
    conversationId: string,
    limit: number | undefined,
    beforeTimestamp?: number,
  ) => {
    let filtered = dbMessages.filter(
      (m) => m.conversationId === conversationId,
    );
    if (beforeTimestamp !== undefined) {
      filtered = filtered.filter((m) => m.createdAt < beforeTimestamp);
    }
    // Sort descending for limit logic (matching real implementation)
    filtered.sort((a, b) => b.createdAt - a.createdAt);
    if (limit !== undefined) {
      const hasMore = filtered.length > limit;
      if (hasMore) filtered = filtered.slice(0, limit);
      filtered.reverse();
      return { messages: filtered, hasMore };
    }
    filtered.reverse();
    return { messages: filtered, hasMore: false };
  },
}));

// ── Import under test ─────────────────────────────────────────────────

import { listConversationMessages } from "../../../daemon/handlers/conversation-history.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeMessage(
  id: string,
  conversationId: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
) {
  return {
    id,
    conversationId,
    role,
    content: JSON.stringify([{ type: "text", text }]),
    createdAt,
    metadata: null,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("listConversationMessages", () => {
  beforeEach(() => {
    dbMessages = [];
  });

  test("returns messages in chronological order", () => {
    dbMessages = [
      makeMessage("m1", "conv-1", "user", "Hello", 1000),
      makeMessage("m2", "conv-1", "assistant", "Hi there", 2000),
      makeMessage("m3", "conv-1", "user", "How are you?", 3000),
    ];

    const result = listConversationMessages("conv-1", 100);

    expect(result.conversationId).toBe("conv-1");
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].id).toBe("m1");
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].text).toBe("Hello");
    expect(result.messages[1].id).toBe("m2");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[2].id).toBe("m3");
    expect(result.hasMore).toBe(false);
    expect(result.nextBeforeTimestamp).toBeUndefined();
  });

  test("limit=N returns exactly N rows with hasMore=true when more exist", () => {
    dbMessages = [
      makeMessage("m1", "conv-1", "user", "First", 1000),
      makeMessage("m2", "conv-1", "assistant", "Second", 2000),
      makeMessage("m3", "conv-1", "user", "Third", 3000),
    ];

    const result = listConversationMessages("conv-1", 2);

    expect(result.messages).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextBeforeTimestamp).toBe(result.messages[0].createdAt);
  });

  test("beforeTimestamp cursor filters correctly and sets nextBeforeTimestamp", () => {
    dbMessages = [
      makeMessage("m1", "conv-1", "user", "First", 1000),
      makeMessage("m2", "conv-1", "assistant", "Second", 2000),
      makeMessage("m3", "conv-1", "user", "Third", 3000),
      makeMessage("m4", "conv-1", "assistant", "Fourth", 4000),
    ];

    const result = listConversationMessages("conv-1", 2, 4000);

    expect(result.messages).toHaveLength(2);
    // Should get m2 and m3 (before timestamp 4000, limited to 2, most recent)
    expect(result.messages[0].id).toBe("m2");
    expect(result.messages[1].id).toBe("m3");
    expect(result.hasMore).toBe(true);
    expect(result.nextBeforeTimestamp).toBe(2000);
  });

  test("unknown conversationId returns empty messages array", () => {
    dbMessages = [makeMessage("m1", "conv-1", "user", "Hello", 1000)];

    const result = listConversationMessages("unknown-conv", 100);

    expect(result.conversationId).toBe("unknown-conv");
    expect(result.messages).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.nextBeforeTimestamp).toBeUndefined();
  });

  test("raw text content (non-JSON) is returned as text", () => {
    dbMessages = [
      {
        id: "m1",
        conversationId: "conv-1",
        role: "user",
        content: "Plain text message",
        createdAt: 1000,
        metadata: null,
      },
    ];

    const result = listConversationMessages("conv-1", 100);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe("Plain text message");
    expect(result.messages[0].role).toBe("user");
  });

  test("messages include id, role, and createdAt fields", () => {
    dbMessages = [
      makeMessage("msg-abc", "conv-1", "assistant", "Response", 5000),
    ];

    const result = listConversationMessages("conv-1", 100);

    expect(result.messages[0].id).toBe("msg-abc");
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].createdAt).toBe(5000);
  });
});
