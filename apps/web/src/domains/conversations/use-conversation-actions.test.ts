import { describe, expect, test } from "bun:test";

import {
  findNextConversationKey,
  resolveUnpinGroupId,
} from "@/domains/conversations/use-conversation-actions.js";
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

// ---------------------------------------------------------------------------
// findNextConversationKey
// ---------------------------------------------------------------------------

describe("findNextConversationKey", () => {
  test("returns the first non-archived foreground conversation", () => {
    const conversations: Conversation[] = [
      makeConversation({ conversationKey: "archived", archivedAt: 1 }),
      makeConversation({ conversationKey: "normal-1" }),
      makeConversation({ conversationKey: "normal-2" }),
    ];
    expect(findNextConversationKey(conversations, "archived")).toBe("normal-1");
  });

  test("skips background conversations (memory retrospective)", () => {
    const conversations: Conversation[] = [
      makeConversation({
        conversationKey: "bg",
        conversationType: "background",
        groupId: "system:background",
      }),
      makeConversation({ conversationKey: "normal" }),
    ];
    expect(findNextConversationKey(conversations, "archived")).toBe("normal");
  });

  test("skips scheduled conversations", () => {
    const conversations: Conversation[] = [
      makeConversation({
        conversationKey: "scheduled",
        conversationType: "scheduled",
        groupId: "system:scheduled",
      }),
      makeConversation({ conversationKey: "normal" }),
    ];
    expect(findNextConversationKey(conversations, "archived")).toBe("normal");
  });

  test("skips the archived conversation itself even if it matches other criteria", () => {
    const conversations: Conversation[] = [
      makeConversation({ conversationKey: "target" }),
    ];
    expect(findNextConversationKey(conversations, "target")).toBeNull();
  });

  test("returns null when only background conversations remain", () => {
    const conversations: Conversation[] = [
      makeConversation({
        conversationKey: "bg-1",
        conversationType: "background",
        groupId: "system:background",
      }),
      makeConversation({
        conversationKey: "bg-2",
        conversationType: "background",
        source: "heartbeat",
      }),
    ];
    expect(findNextConversationKey(conversations, "archived")).toBeNull();
  });

  test("returns null for empty conversation list", () => {
    expect(findNextConversationKey([], "archived")).toBeNull();
  });

  test("prefers earlier foreground conversations over later ones", () => {
    const conversations: Conversation[] = [
      makeConversation({ conversationKey: "first" }),
      makeConversation({ conversationKey: "second" }),
      makeConversation({ conversationKey: "third" }),
    ];
    expect(findNextConversationKey(conversations, "none")).toBe("first");
  });
});
