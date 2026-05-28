import type { QueryClient } from "@tanstack/react-query";
import type { RelationshipStateUpdatedEvent } from "@vellumai/assistant-api";
import type { HomeFeedUpdatedEvent } from "@/domains/chat/api/event-types";
import { HOME_FEED_QUERY_KEY_PREFIX } from "@/lib/sync/query-tags";

export function handleHomeFeedUpdated(
  queryClient: QueryClient,
  _event: HomeFeedUpdatedEvent,
): void {
  queryClient.invalidateQueries({ queryKey: [HOME_FEED_QUERY_KEY_PREFIX] });
}

export function handleRelationshipStateUpdated(
  queryClient: QueryClient,
  _event: RelationshipStateUpdatedEvent,
): void {
  queryClient.invalidateQueries({ queryKey: ["home-state"] });
}
