/**
 * Hand-written fetch wrappers for daemon home endpoints.
 *
 * These endpoints are not in the Django OpenAPI schema, so we use the
 * HeyAPI client singleton directly rather than generated hooks.
 */
import { client } from "@/lib/api-client.js";
import { assertHasResponse } from "@/lib/api-errors.js";
import type {
  FeedItem,
  FeedItemStatus,
  HomeFeedResponse,
  RelationshipState,
} from "./types.js";

export async function fetchHomeFeed(
  assistantId: string,
  timeAwaySeconds: number = 0,
): Promise<HomeFeedResponse> {
  const { data, error, response } = await client.get({
    url: "/v1/assistants/{assistant_id}/home/feed",
    path: { assistant_id: assistantId },
    query: { timeAwaySeconds },
  });
  assertHasResponse(response, error, "Failed to fetch home feed");
  if (!response.ok) {
    throw new Error(`Failed to fetch home feed: ${response.status}`);
  }
  return data as HomeFeedResponse;
}

export async function fetchRelationshipState(
  assistantId: string,
): Promise<RelationshipState> {
  const { data, error, response } = await client.get({
    url: "/v1/assistants/{assistant_id}/home/state",
    path: { assistant_id: assistantId },
  });
  assertHasResponse(response, error, "Failed to fetch relationship state");
  if (!response.ok) {
    throw new Error(`Failed to fetch relationship state: ${response.status}`);
  }
  return data as RelationshipState;
}

export async function updateFeedItemStatus(
  assistantId: string,
  itemId: string,
  status: FeedItemStatus,
): Promise<FeedItem> {
  const { data, error, response } = await client.patch({
    url: "/v1/assistants/{assistant_id}/home/feed/{item_id}",
    path: { assistant_id: assistantId, item_id: itemId },
    body: { status },
  });
  assertHasResponse(response, error, "Failed to update feed item");
  if (!response.ok) {
    throw new Error(`Failed to update feed item: ${response.status}`);
  }
  return data as FeedItem;
}

export async function triggerFeedAction(
  assistantId: string,
  itemId: string,
  actionId: string,
): Promise<{ conversationId: string }> {
  const { data, error, response } = await client.post({
    url: "/v1/assistants/{assistant_id}/home/feed/{item_id}/actions/{action_id}",
    path: {
      assistant_id: assistantId,
      item_id: itemId,
      action_id: actionId,
    },
    body: {},
  });
  assertHasResponse(response, error, "Failed to trigger feed action");
  if (!response.ok) {
    throw new Error(`Failed to trigger feed action: ${response.status}`);
  }
  return data as { conversationId: string };
}
