import { describe, expect, test } from "bun:test";

import type { Conversation } from "@/types/conversation-types";
import {
  canMarkRead,
  canMarkUnread,
  contributesToUnreadCount,
  countUnreadConversationsInList,
  isBackgroundConversation,
  isScheduledConversation,
} from "@/utils/conversation-predicates";

function makeConversation(overrides: Partial<Conversation>): Conversation {
  return { conversationId: "conv-1", ...overrides };
}

describe("isBackgroundConversation", () => {
  test("classifies background/scheduled rows by type and legacy groupId", () => {
    expect(
      isBackgroundConversation(
        makeConversation({ conversationType: "background" }),
      ),
    ).toBe(true);
    expect(
      isBackgroundConversation(
        makeConversation({ conversationType: "scheduled" }),
      ),
    ).toBe(true);
    expect(
      isBackgroundConversation(
        makeConversation({ groupId: "system:background" }),
      ),
    ).toBe(true);
    expect(
      isBackgroundConversation(
        makeConversation({ groupId: "system:scheduled" }),
      ),
    ).toBe(true);
    expect(
      isBackgroundConversation(
        makeConversation({ conversationType: "standard" }),
      ),
    ).toBe(false);
  });

  test("treats surfaced rows as foreground regardless of type or groupId", () => {
    expect(
      isBackgroundConversation(
        makeConversation({
          conversationType: "background",
          surfacedAt: 1704067200000,
        }),
      ),
    ).toBe(false);
    expect(
      isBackgroundConversation(
        makeConversation({
          conversationType: "scheduled",
          surfacedAt: 1704067200000,
        }),
      ),
    ).toBe(false);
    expect(
      isBackgroundConversation(
        makeConversation({
          groupId: "system:background",
          surfacedAt: 1704067200000,
        }),
      ),
    ).toBe(false);
  });
});

describe("isScheduledConversation", () => {
  test("classifies scheduled rows by type and groupId", () => {
    expect(
      isScheduledConversation(
        makeConversation({ conversationType: "scheduled" }),
      ),
    ).toBe(true);
    expect(
      isScheduledConversation(
        makeConversation({ groupId: "system:scheduled" }),
      ),
    ).toBe(true);
    expect(
      isScheduledConversation(
        makeConversation({ conversationType: "background" }),
      ),
    ).toBe(false);
  });

  test("ignores surfacedAt — surfaced scheduled rows are still scheduled jobs", () => {
    // Type classifier, not a visibility predicate: surfacing adds Recents
    // visibility but the row stays in the scheduled filtered listing/cache.
    expect(
      isScheduledConversation(
        makeConversation({
          conversationType: "scheduled",
          surfacedAt: 1704067200000,
        }),
      ),
    ).toBe(true);
  });
});

describe("unread predicates for surfaced conversations", () => {
  test("surfaced background rows can be marked read/unread", () => {
    const unseenSurfaced = makeConversation({
      conversationType: "background",
      surfacedAt: 1704067200000,
      hasUnseenLatestAssistantMessage: true,
    });
    expect(canMarkRead(unseenSurfaced)).toBe(true);

    const seenSurfaced = makeConversation({
      conversationType: "background",
      surfacedAt: 1704067200000,
      hasUnseenLatestAssistantMessage: false,
      latestAssistantMessageAt: 1704067200000,
    });
    expect(canMarkUnread(seenSurfaced)).toBe(true);
  });

  test("non-surfaced background rows keep suppressed read/unread actions", () => {
    const unseenBackground = makeConversation({
      conversationType: "background",
      hasUnseenLatestAssistantMessage: true,
    });
    expect(canMarkRead(unseenBackground)).toBe(false);

    const seenBackground = makeConversation({
      conversationType: "background",
      hasUnseenLatestAssistantMessage: false,
      latestAssistantMessageAt: 1704067200000,
    });
    expect(canMarkUnread(seenBackground)).toBe(false);
  });

  test("surfaced background rows contribute to unread counters", () => {
    expect(
      contributesToUnreadCount(
        makeConversation({
          conversationType: "background",
          surfacedAt: 1704067200000,
          hasUnseenLatestAssistantMessage: true,
        }),
      ),
    ).toBe(true);
    expect(
      contributesToUnreadCount(
        makeConversation({
          conversationType: "background",
          hasUnseenLatestAssistantMessage: true,
        }),
      ),
    ).toBe(false);
  });

  test("archived surfaced rows stay out of unread counters", () => {
    expect(
      contributesToUnreadCount(
        makeConversation({
          conversationType: "background",
          surfacedAt: 1704067200000,
          archivedAt: 1704153600000,
          hasUnseenLatestAssistantMessage: true,
        }),
      ),
    ).toBe(false);
  });
});

/**
 * The client half of the unread-count contract.
 *
 * `GET /v1/conversations/unread-count` answers the same question in SQL
 * (`countUnreadConversations` in
 * `assistant/src/persistence/conversation-queries.ts`), and the daemon's
 * `conversation-list-routes.test.ts` asserts this same matrix against the
 * database. The two definitions are maintained separately, so this matrix is
 * the tripwire: a rule changed on one side without the other shows up as one
 * of these scenarios disagreeing across the two suites.
 *
 * Keep the scenario names identical on both sides.
 */
describe("unread-count contract (client half)", () => {
  const scenarios: Array<{
    name: string;
    conversation: Partial<Conversation>;
    counts: boolean;
  }> = [
    {
      name: "unseen foreground row",
      conversation: { hasUnseenLatestAssistantMessage: true },
      counts: true,
    },
    {
      name: "seen foreground row",
      conversation: { hasUnseenLatestAssistantMessage: false },
      counts: false,
    },
    {
      name: "unseen archived row",
      conversation: {
        hasUnseenLatestAssistantMessage: true,
        archivedAt: 1704153600000,
      },
      counts: false,
    },
    {
      name: "unseen background row, not surfaced",
      conversation: {
        hasUnseenLatestAssistantMessage: true,
        conversationType: "background",
      },
      counts: false,
    },
    {
      name: "unseen scheduled row, not surfaced",
      conversation: {
        hasUnseenLatestAssistantMessage: true,
        conversationType: "scheduled",
      },
      counts: false,
    },
    {
      name: "unseen background row, surfaced",
      conversation: {
        hasUnseenLatestAssistantMessage: true,
        conversationType: "background",
        surfacedAt: 1704067200000,
      },
      counts: true,
    },
    {
      name: "unseen background row filed in a custom group, not surfaced",
      conversation: {
        hasUnseenLatestAssistantMessage: true,
        conversationType: "background",
        groupId: "3f0b7a4e-1111-2222-3333-444455556666",
      },
      counts: false,
    },
    {
      name: "unseen standard row filed in a custom group",
      conversation: {
        hasUnseenLatestAssistantMessage: true,
        groupId: "3f0b7a4e-1111-2222-3333-444455556666",
      },
      counts: true,
    },
  ];

  for (const scenario of scenarios) {
    test(`${scenario.name} ${scenario.counts ? "counts" : "does not count"}`, () => {
      expect(
        contributesToUnreadCount(makeConversation(scenario.conversation)),
      ).toBe(scenario.counts);
    });
  }

  test("the matrix totals what countUnreadConversationsInList reports", () => {
    const expected = scenarios.filter((s) => s.counts).length;
    const list = scenarios.map((s, index) =>
      makeConversation({ ...s.conversation, conversationId: `conv-${index}` }),
    );

    expect(countUnreadConversationsInList(list)).toBe(expected);
  });
});
