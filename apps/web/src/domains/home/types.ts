/**
 * Home feed and relationship-state types.
 *
 * The wire shapes are owned by the daemon and surfaced through the generated
 * daemon SDK, so they are derived from the generated response types rather
 * than re-declared here. Purely client-side concepts that never cross the
 * wire (e.g. feed time bucketing) are declared directly.
 */
import type {
  HomeFeedGetResponse,
  HomeStateGetResponse,
} from "@/generated/daemon/types.gen";

export type HomeFeedResponse = HomeFeedGetResponse;
export type FeedItem = HomeFeedResponse["items"][number];
export type FeedItemStatus = FeedItem["status"];
export type FeedItemCategory = NonNullable<FeedItem["category"]>;
export type SuggestedPrompt = HomeFeedResponse["suggestedPrompts"][number];

export type RelationshipState = HomeStateGetResponse;

/**
 * Client-side grouping of feed items by recency. Not part of the wire
 * contract — derived in the UI from each item's `createdAt`.
 */
export type FeedTimeGroup = "today" | "yesterday" | "older";
