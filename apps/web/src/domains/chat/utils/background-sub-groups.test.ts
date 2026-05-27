import { describe, expect, test } from "bun:test";


import type { Conversation } from "@/types/conversation-types";
import {
  formatBackgroundSubGroupLabel,
  groupBackgroundConversationsBySource,
} from "@/domains/chat/utils/background-sub-groups";

function makeConversation(
  conversationId: string,
  source?: string,
): Conversation {
  return { conversationId, source };
}

describe("formatBackgroundSubGroupLabel", () => {
  test("maps 'auto-analysis' to 'Reflections' to match macOS", () => {
    /**
     * The macOS sidebar relabels the auto-analysis source to a
     * user-facing "Reflections" heading. The web sidebar should match.
     */
    // GIVEN the auto-analysis source value emitted by the runtime
    const source = "auto-analysis";

    // WHEN we format it for the sidebar
    const label = formatBackgroundSubGroupLabel(source);

    // THEN it renders as the macOS-compatible label
    expect(label).toBe("Reflections");
  });

  test("capitalizes other source values", () => {
    /**
     * Non-special source values are rendered with their first letter
     * capitalized so that raw runtime identifiers aren't shown to users.
     */
    // GIVEN a lowercase source value
    const source = "heartbeat";

    // WHEN we format it for the sidebar
    const label = formatBackgroundSubGroupLabel(source);

    // THEN it is capitalized
    expect(label).toBe("Heartbeat");
  });

  test("falls back to 'Other' for an empty source", () => {
    /**
     * The empty-string fallback exists as a safety net — sourceless
     * conversations normally get a unique key and render inline, but the
     * formatter must still return a safe label.
     */
    // GIVEN an empty source value
    const source = "";

    // WHEN we format it for the sidebar
    const label = formatBackgroundSubGroupLabel(source);

    // THEN it falls back to the generic "Other" label
    expect(label).toBe("Other");
  });
});

describe("groupBackgroundConversationsBySource", () => {
  test("groups conversations that share a source", () => {
    /**
     * Multiple conversations with the same `source` should collapse into
     * a single sub-group so the sidebar can render them under one heading.
     */
    // GIVEN three heartbeat conversations
    const conversations = [
      makeConversation("a", "heartbeat"),
      makeConversation("b", "heartbeat"),
      makeConversation("c", "heartbeat"),
    ];

    // WHEN we group them
    const result = groupBackgroundConversationsBySource(conversations);

    // THEN they collapse into a single "Heartbeat" sub-group in order
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("heartbeat");
    expect(result[0]?.label).toBe("Heartbeat");
    expect(result[0]?.conversations.map((c) => c.conversationId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("assigns sourceless conversations unique keys so they render inline", () => {
    /**
     * Conversations without a `source` should never be bucketed together
     * under a vague "Other" heading — each one must get its own entry so
     * the caller renders it as a single inline row.
     */
    // GIVEN two sourceless conversations
    const conversations = [
      makeConversation("a"),
      makeConversation("b"),
    ];

    // WHEN we group them
    const result = groupBackgroundConversationsBySource(conversations);

    // THEN each gets its own single-conversation sub-group with a distinct key
    expect(result).toHaveLength(2);
    expect(result[0]?.key).not.toBe(result[1]?.key);
    expect(result[0]?.conversations).toHaveLength(1);
    expect(result[1]?.conversations).toHaveLength(1);
  });

  test("preserves insertion order across multiple sources", () => {
    /**
     * The sidebar relies on the grouping function to preserve the order
     * of the first appearance of each source so that the most recently
     * active sub-group can be placed at the top by the caller.
     */
    // GIVEN a mix of sources in a specific interleaved order
    const conversations = [
      makeConversation("a", "heartbeat"),
      makeConversation("b", "auto-analysis"),
      makeConversation("c", "heartbeat"),
      makeConversation("d", "task"),
    ];

    // WHEN we group them
    const result = groupBackgroundConversationsBySource(conversations);

    // THEN the sub-groups appear in first-seen order
    expect(result.map((g) => g.key)).toEqual([
      "heartbeat",
      "auto-analysis",
      "task",
    ]);

    // AND the auto-analysis group is labeled "Reflections"
    const reflections = result.find((g) => g.key === "auto-analysis");
    expect(reflections?.label).toBe("Reflections");
  });

  test("returns an empty array when there are no conversations", () => {
    /**
     * An empty input must produce an empty output so the sidebar can
     * hide the background section entirely without a special case.
     */
    // GIVEN no conversations
    const conversations: Conversation[] = [];

    // WHEN we group them
    const result = groupBackgroundConversationsBySource(conversations);

    // THEN the result is empty
    expect(result).toEqual([]);
  });
});
