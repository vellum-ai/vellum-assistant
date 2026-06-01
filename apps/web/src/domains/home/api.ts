/**
 * Fetch wrappers for the daemon home endpoints, built on the generated
 * daemon SDK so request/response types stay in sync with the route schemas.
 */
import {
  homeFeedByIdActionsByActionIdPost,
  homeFeedByIdPatch,
  homeFeedGet,
  homeStateGet,
} from "@/generated/daemon/sdk.gen";
import { assertHasResponse } from "@/utils/api-errors";
import type {
  FeedItem,
  FeedItemStatus,
  HomeFeedResponse,
  RelationshipState,
} from "./types";

export async function fetchHomeFeed(
  assistantId: string,
  timeAwaySeconds: number = 0,
): Promise<HomeFeedResponse> {
  const { data, error, response } = await homeFeedGet({
    path: { assistant_id: assistantId },
    query: { timeAwaySeconds },
  });
  assertHasResponse(response, error, "Failed to fetch home feed");
  if (!response.ok || !data) {
    throw new Error(`Failed to fetch home feed: ${response.status}`);
  }
  return data;
}

export async function fetchRelationshipState(
  assistantId: string,
): Promise<RelationshipState> {
  const { data, error, response } = await homeStateGet({
    path: { assistant_id: assistantId },
  });
  assertHasResponse(response, error, "Failed to fetch relationship state");
  if (!response.ok || !data) {
    throw new Error(`Failed to fetch relationship state: ${response.status}`);
  }
  return data;
}

export async function updateFeedItemStatus(
  assistantId: string,
  itemId: string,
  status: FeedItemStatus,
): Promise<FeedItem> {
  const { data, error, response } = await homeFeedByIdPatch({
    path: { assistant_id: assistantId, id: itemId },
    body: { status },
  });
  assertHasResponse(response, error, "Failed to update feed item");
  if (!response.ok || !data) {
    throw new Error(`Failed to update feed item: ${response.status}`);
  }
  return data;
}

export async function triggerFeedAction(
  assistantId: string,
  itemId: string,
  actionId: string,
): Promise<{ conversationId: string }> {
  const { data, error, response } = await homeFeedByIdActionsByActionIdPost({
    path: {
      assistant_id: assistantId,
      id: itemId,
      actionId,
    },
  });
  assertHasResponse(response, error, "Failed to trigger feed action");
  if (!response.ok || !data) {
    throw new Error(`Failed to trigger feed action: ${response.status}`);
  }
  return data;
}
