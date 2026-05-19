import { describe, expect, test } from "bun:test";

import type { Conversation } from "@/domains/chat/lib/api.js";

import { patchConversation } from "@/domains/chat/lib/conversation-list-state.js";
import { resolveUnpinGroupId } from "@/domains/chat/hooks/use-conversation-actions.js";

// ---------------------------------------------------------------------------
// patchConversation
// ---------------------------------------------------------------------------

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return { conversationKey: "conv-1", ...overrides };
}

describe("patchConversation", () => {
  test("patches the matching conversation by key", () => {
    const convs = [
      makeConversation({ conversationKey: "a", title: "old" }),
      makeConversation({ conversationKey: "b", title: "keep" }),
    ];
    const result = patchConversation(convs, "a", { title: "new" });
    expect(result[0]!.title).toBe("new");
    expect(result[1]!.title).toBe("keep");
  });

  test("returns a new array (immutable)", () => {
    const convs = [makeConversation()];
    const result = patchConversation(convs, "conv-1", { title: "x" });
    expect(result).not.toBe(convs);
    expect(result[0]).not.toBe(convs[0]);
  });

  test("leaves all conversations unchanged when key does not match", () => {
    const convs = [
      makeConversation({ conversationKey: "a", title: "keep" }),
    ];
    const result = patchConversation(convs, "no-match", { title: "nope" });
    expect(result[0]!.title).toBe("keep");
  });

  test("applies multiple fields at once", () => {
    const convs = [makeConversation({ conversationKey: "a" })];
    const result = patchConversation(convs, "a", {
      isPinned: true,
      groupId: "system:pinned",
    });
    expect(result[0]!.isPinned).toBe(true);
    expect(result[0]!.groupId).toBe("system:pinned");
  });

  test("handles empty array", () => {
    const result = patchConversation([], "a", { title: "x" });
    expect(result).toEqual([]);
  });
});

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
