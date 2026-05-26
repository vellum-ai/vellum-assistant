import type { QueryClient } from "@tanstack/react-query";
import type { RelationshipStateUpdated } from "@vellumai/assistant-api";
import type { HomeFeedUpdatedEvent } from "@/domains/chat/api/event-types.js";

export function handleHomeFeedUpdated(
  queryClient: QueryClient,
  _event: HomeFeedUpdatedEvent,
): void {
  queryClient.invalidateQueries({ queryKey: ["home-feed"] });
}

export function handleRelationshipStateUpdated(
  queryClient: QueryClient,
  _event: RelationshipStateUpdated,
): void {
  queryClient.invalidateQueries({ queryKey: ["home-state"] });
}
