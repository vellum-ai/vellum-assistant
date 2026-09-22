import type { FeedItem, FeedItemUpdate } from "@vellumai/assistant-api";

/**
 * Build a `FeedItem` carrying the fields the daemon always writes, so a
 * caller only states what makes its case distinct.
 *
 * Accepts the component's own data shape: there is no transformation from
 * some other input format, and no cast, so the type system still enforces
 * that a fixture is something the backend could actually produce.
 *
 * `timestamp` is the event time and `createdAt` is when the feed writer
 * recorded it. The daemon sets both and they are not the same value, so the
 * defaults keep them distinct.
 */
export function feedItem(
  overrides: Partial<FeedItem> & Pick<FeedItem, "id">,
): FeedItem {
  return {
    type: "notification",
    priority: 50,
    summary: "",
    timestamp: "2026-08-05T18:30:00.000Z",
    createdAt: "2026-08-05T18:30:02.000Z",
    status: "new",
    ...overrides,
  };
}

/** A conversation the feed is allowed to link to. */
export const FIXTURE_CONVERSATION_ID = "conv-weekly-report";

/**
 * The resolvable-conversation set the feed passes down. A row or panel hides
 * its jump target when an item's conversation is absent here, which is what
 * happens once a background fork is garbage collected.
 */
export const FIXTURE_VALID_CONVERSATIONS = new Set([FIXTURE_CONVERSATION_ID]);

/** A second source conversation, for a receipt spanning more than one. */
export const FIXTURE_SECOND_CONVERSATION_ID = "conv-release-checklist";

/**
 * The updates a background burst made across three skills, one of them twice,
 * from two source conversations: the shape a receipt lists. Entries are in
 * rewrite order, and the repeat names its skill again the way the daemon
 * writes it, so a reader sees the grouping the panel does, not the wire.
 */
export const FIXTURE_SKILL_UPDATES: FeedItemUpdate[] = [
  {
    skillId: "approved-pr-merge-gate",
    name: "Approved PR Merge Gate",
    summary:
      "Added the receipt step after the merge and the check that the approval is still current before merging.",
    conversationId: FIXTURE_CONVERSATION_ID,
  },
  {
    skillId: "release-notes-draft",
    name: "Release Notes Draft",
    summary:
      "Groups the merged changes by user-facing area before drafting, and drops the internal refactors from the draft.",
    conversationId: FIXTURE_SECOND_CONVERSATION_ID,
  },
  {
    skillId: "approved-pr-merge-gate",
    name: "Approved PR Merge Gate",
    summary:
      "Waits for the required checks to finish rather than reading their last result, after a merge landed on a stale run.",
    conversationId: FIXTURE_SECOND_CONVERSATION_ID,
  },
  {
    skillId: "weekly-report-export",
    name: "Weekly Report Export",
    summary:
      "Exports the report as a shared document instead of an attachment, since the attachment was too large to send.",
  },
];

/**
 * A skill-update receipt as the daemon writes one: the panel kind, the
 * entries, and a plain-text summary carrying the same content for a client
 * without the panel. A receipt naming one skill or one source also carries
 * that id where a single notification does (`metadata.skillId`,
 * `conversationId`); this one spans several of each, so it carries neither.
 */
export function skillUpdateReceipt(
  overrides: Partial<FeedItem> & Pick<FeedItem, "id">,
): FeedItem {
  const updates = overrides.updates ?? FIXTURE_SKILL_UPDATES;
  return feedItem({
    title: `${new Set(updates.map((update) => update.skillId)).size} skills updated`,
    summary: updates
      .map((update) => `- ${update.name}: ${update.summary}`)
      .join("\n"),
    category: "background",
    urgency: "low",
    detailPanel: { kind: "updatesList" },
    updates,
    ...overrides,
  });
}
