import type { QueryClient } from "@tanstack/react-query";
import type {
  HomeFeedUpdatedEvent,
  RelationshipStateUpdatedEvent,
} from "@/domains/chat/lib/event-types.js";

export function handleHomeFeedUpdated(
  queryClient: QueryClient,
  _event: HomeFeedUpdatedEvent,
): void {
  queryClient.invalidateQueries({ queryKey: ["home-feed"] });
}

export function handleRelationshipStateUpdated(
  queryClient: QueryClient,
  _event: RelationshipStateUpdatedEvent,
): void {
  queryClient.invalidateQueries({ queryKey: ["home-state"] });
}
