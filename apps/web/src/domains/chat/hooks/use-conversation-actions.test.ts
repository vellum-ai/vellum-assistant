import { describe, expect, test } from "bun:test";

import {
  findNextConversationId,
  resolveUnpinGroupId,
} from "@/domains/chat/hooks/conversation-action-utils";
import type { Conversation } from "@/types/conversation-types";

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return { conversationId: "conv-1", ...overrides };
}

// ---------------------------------------------------------------------------
// resolveUnpinGroupId
// ---------------------------------------------------------------------------

describe("resolveUnpinGroupId", () => {
  test("returns stored groupId from pre-pin cache when available", () => {
    const conv = makeConversation({ conversationId: "a" });
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
      [conv.conversationId, "user-group"],
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
      [conv.conversationId, undefined],
    ]);
    expect(resolveUnpinGroupId(conv, cache)).toBe("system:scheduled");
  });
});

// ---------------------------------------------------------------------------
// findNextConversationId
// ---------------------------------------------------------------------------

describe("findNextConversationId", () => {
  test("returns the first non-archived foreground conversation", () => {
    const conversations: Conversation[] = [
      makeConversation({ conversationId: "archived", archivedAt: 1 }),
      makeConversation({ conversationId: "normal-1" }),
      makeConversation({ conversationId: "normal-2" }),
    ];
    expect(findNextConversationId(conversations, "archived")).toBe("normal-1");
  });

  test("skips background conversations (memory retrospective)", () => {
    const conversations: Conversation[] = [
      makeConversation({
        conversationId: "bg",
        conversationType: "background",
        groupId: "system:background",
      }),
      makeConversation({ conversationId: "normal" }),
    ];
    expect(findNextConversationId(conversations, "archived")).toBe("normal");
  });

  test("skips scheduled conversations", () => {
    const conversations: Conversation[] = [
      makeConversation({
        conversationId: "scheduled",
        conversationType: "scheduled",
        groupId: "system:scheduled",
      }),
      makeConversation({ conversationId: "normal" }),
    ];
    expect(findNextConversationId(conversations, "archived")).toBe("normal");
  });

  test("skips the archived conversation itself even if it matches other criteria", () => {
    const conversations: Conversation[] = [
      makeConversation({ conversationId: "target" }),
    ];
    expect(findNextConversationId(conversations, "target")).toBeNull();
  });

  test("returns null when only background conversations remain", () => {
    const conversations: Conversation[] = [
      makeConversation({
        conversationId: "bg-1",
        conversationType: "background",
        groupId: "system:background",
      }),
      makeConversation({
        conversationId: "bg-2",
        conversationType: "background",
        source: "heartbeat",
      }),
    ];
    expect(findNextConversationId(conversations, "archived")).toBeNull();
  });

  test("returns null for empty conversation list", () => {
    expect(findNextConversationId([], "archived")).toBeNull();
  });

  test("prefers earlier foreground conversations over later ones", () => {
    const conversations: Conversation[] = [
      makeConversation({ conversationId: "first" }),
      makeConversation({ conversationId: "second" }),
      makeConversation({ conversationId: "third" }),
    ];
    expect(findNextConversationId(conversations, "none")).toBe("first");
  });
});
