import type { FeedItem } from "@vellumai/assistant-api";

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
