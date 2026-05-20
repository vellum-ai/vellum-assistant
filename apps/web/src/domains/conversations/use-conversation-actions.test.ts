import { describe, expect, test } from "bun:test";

import { resolveUnpinGroupId } from "@/domains/conversations/use-conversation-actions.js";
import type { Conversation } from "@/domains/chat/api/conversations.js";

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return { conversationKey: "conv-1", ...overrides };
}

// ---------------------------------------------------------------------------
// resolveUnpinGroupId
// ---------------------------------------------------------------------------

describe("resolveUnpinGroupId", () => {
  test("returns stored groupId from pre-pin cache when available", () => {
    const conv = makeConversation({ conversationKey: "a" });
    const cache = new Map<string, string | undefined>([["a", "custom-group"]]);
    expect(resolveUnpinGroupId(conv, cache)).toBe("custom-group");
  });

  test("returns system:background for heartbeat source conversations", () => {
    const conv = makeConversation({ source: "heartbeat" });
    const cache = new Map<string, string | undefined>();
    expect(resolveUnpinGroupId(conv, cache)).toBe("system:background");
  });

  test("returns system:background for task source conversations", () => {
    const conv = makeConversation({ source: "task" });
    const cache = new Map<string, string | undefined>();
    expect(resolveUnpinGroupId(conv, cache)).toBe("system:background");
  });

  test("returns system:background for auto-analysis source conversations", () => {
    const conv = makeConversation({ source: "auto-analysis" });
    const cache = new Map<string, string | undefined>();
    expect(resolveUnpinGroupId(conv, cache)).toBe("system:background");
  });

  test("returns system:scheduled for scheduled conversationType", () => {
    const conv = makeConversation({ conversationType: "scheduled" });
    const cache = new Map<string, string | undefined>();
    expect(resolveUnpinGroupId(conv, cache)).toBe("system:scheduled");
  });

  test("returns system:all for Slack-origin conversations with scheduled/background metadata", () => {
    const cache = new Map<string, string | undefined>();
    expect(
      resolveUnpinGroupId(
        makeConversation({
          conversationType: "scheduled",
          originChannel: "slack",
        }),
        cache,
      ),
    ).toBe("system:all");
    expect(
      resolveUnpinGroupId(
        makeConversation({
          conversationType: "background",
          originChannel: "slack",
          source: "heartbeat",
        }),
        cache,
      ),
    ).toBe("system:all");
  });

  test("returns system:background for background conversationType", () => {
    const conv = makeConversation({ conversationType: "background" });
    const cache = new Map<string, string | undefined>();
    expect(resolveUnpinGroupId(conv, cache)).toBe("system:background");
  });

  test("returns system:all as default fallback", () => {
    const conv = makeConversation();
    const cache = new Map<string, string | undefined>();
    expect(resolveUnpinGroupId(conv, cache)).toBe("system:all");
  });

  test("prefers cached groupId over source-based heuristic", () => {
    const conv = makeConversation({ source: "heartbeat" });
    const cache = new Map<string, string | undefined>([
      [conv.conversationKey, "user-group"],
    ]);
    expect(resolveUnpinGroupId(conv, cache)).toBe("user-group");
  });

  test("source-based check takes priority over conversationType", () => {
    const conv = makeConversation({
      source: "heartbeat",
      conversationType: "scheduled",
    });
    const cache = new Map<string, string | undefined>();
    expect(resolveUnpinGroupId(conv, cache)).toBe("system:background");
  });

  test("skips undefined cache entries and falls through to heuristics", () => {
    const conv = makeConversation({ conversationType: "scheduled" });
    const cache = new Map<string, string | undefined>([
      [conv.conversationKey, undefined],
    ]);
    expect(resolveUnpinGroupId(conv, cache)).toBe("system:scheduled");
  });
});
