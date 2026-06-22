import { describe, expect, test } from "bun:test";


import type { Conversation } from "@/types/conversation-types";
import {
  formatScheduledSubGroupLabel,
  groupScheduledConversationsByJobId,
} from "@/domains/chat/utils/scheduled-sub-groups";

function makeConversation(
  conversationId: string,
  scheduleJobId?: string,
  title?: string,
): Conversation {
  return { conversationId, scheduleJobId, title };
}

describe("formatScheduledSubGroupLabel", () => {
  test("uses the first conversation's title when available", () => {
    /**
     * When the first conversation in a schedule group has a title, the
     * label should use that title for the collapsible heading.
     */
    // GIVEN a conversation with a title
    const conv = makeConversation("a", "job-1", "Daily standup");

    // WHEN we format the label
    const label = formatScheduledSubGroupLabel("job-1", conv);

    // THEN it uses the conversation title
    expect(label).toBe("Daily standup");
  });

  test("falls back to the scheduleJobId when no title exists", () => {
    /**
     * When the first conversation has no title, the raw job ID is used
     * as the heading so the user can still identify the schedule group.
     */
    // GIVEN a conversation without a title
    const conv = makeConversation("a", "job-1");

    // WHEN we format the label
    const label = formatScheduledSubGroupLabel("job-1", conv);

    // THEN it falls back to the job ID
    expect(label).toBe("job-1");
  });

  test("falls back to 'Scheduled' when both are empty", () => {
    /**
     * The empty-string fallback exists as a safety net for conversations
     * with neither a title nor a job ID.
     */
    // GIVEN a conversation with no title and an empty job ID
    const conv = makeConversation("a");

    // WHEN we format the label
    const label = formatScheduledSubGroupLabel("", conv);

    // THEN it falls back to the generic "Scheduled" label
    expect(label).toBe("Scheduled");
  });
});

describe("groupScheduledConversationsByJobId", () => {
  test("groups conversations that share a scheduleJobId", () => {
    /**
     * Multiple conversations with the same `scheduleJobId` should collapse
     * into a single sub-group so the sidebar can render them under one heading.
     */
    // GIVEN three conversations from the same schedule job
    const conversations = [
      makeConversation("a", "job-1", "Daily standup"),
      makeConversation("b", "job-1", "Daily standup (2)"),
      makeConversation("c", "job-1", "Daily standup (3)"),
    ];

    // WHEN we group them
    const result = groupScheduledConversationsByJobId(conversations);

    // THEN they collapse into a single sub-group keyed by the job ID
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("job-1");
    expect(result[0]?.label).toBe("Daily standup");
    expect(result[0]?.conversations.map((c) => c.conversationId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("assigns jobless conversations unique keys so they render inline", () => {
    /**
     * Conversations without a `scheduleJobId` should never be bucketed
     * together — each one must get its own entry so the caller renders
     * it as a single inline row.
     */
    // GIVEN two conversations without a schedule job ID
    const conversations = [
      makeConversation("a"),
      makeConversation("b"),
    ];

    // WHEN we group them
    const result = groupScheduledConversationsByJobId(conversations);

    // THEN each gets its own single-conversation sub-group with a distinct key
    expect(result).toHaveLength(2);
    expect(result[0]?.key).not.toBe(result[1]?.key);
    expect(result[0]?.conversations).toHaveLength(1);
    expect(result[1]?.conversations).toHaveLength(1);
  });

  test("preserves insertion order across multiple jobs", () => {
    /**
     * The sidebar relies on the grouping function to preserve the order
     * of the first appearance of each job ID so that the most recently
     * active sub-group can be placed at the top by the caller.
     */
    // GIVEN a mix of job IDs in a specific interleaved order
    const conversations = [
      makeConversation("a", "job-1", "Daily standup"),
      makeConversation("b", "job-2", "Weekly review"),
      makeConversation("c", "job-1", "Daily standup (2)"),
      makeConversation("d", "job-3", "Monthly report"),
    ];

    // WHEN we group them
    const result = groupScheduledConversationsByJobId(conversations);

    // THEN the sub-groups appear in first-seen order
    expect(result.map((g) => g.key)).toEqual(["job-1", "job-2", "job-3"]);
  });

  test("returns an empty array when there are no conversations", () => {
    /**
     * An empty input must produce an empty output so the sidebar can
     * hide the scheduled section entirely without a special case.
     */
    // GIVEN no conversations
    const conversations: Conversation[] = [];

    // WHEN we group them
    const result = groupScheduledConversationsByJobId(conversations);

    // THEN the result is empty
    expect(result).toEqual([]);
  });

  test("uses the first conversation's title as label for a multi-item group", () => {
    /**
     * When multiple conversations share a scheduleJobId, the label for
     * the sub-group should be derived from the first conversation's title.
     */
    // GIVEN two conversations with the same job ID, first has a title
    const conversations = [
      makeConversation("a", "job-1", "Morning check"),
      makeConversation("b", "job-1"),
    ];

    // WHEN we group them
    const result = groupScheduledConversationsByJobId(conversations);

    // THEN the label comes from the first conversation's title
    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe("Morning check");
  });
});
