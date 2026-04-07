/**
 * Internal home feed routes.
 *
 * Provides an action proxy endpoint that lets clients trigger feed
 * item actions. The endpoint reads the feed file, validates the
 * item/action pair, and creates a new conversation with context.
 */

import { readFeedItems } from "../../home/feed-writer.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("home-feed-routes");

export function homeFeedRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "internal/home/feed/:itemId/actions/:actionId",
      method: "POST",
      summary: "Trigger a feed item action",
      description:
        "Look up a feed item and action, then create a conversation with context about the user tapping that action.",
      tags: ["home"],
      handler: async ({ params }) => {
        const { itemId, actionId } = params;

        const workspaceDir = getWorkspaceDir();
        const feed = await readFeedItems(workspaceDir);

        const item = feed.items.find((i) => i.id === itemId);
        if (!item) {
          return httpError("NOT_FOUND", `Feed item '${itemId}' not found`, 404);
        }

        const action = item.actions?.find((a) => a.id === actionId);
        if (!action) {
          return httpError(
            "NOT_FOUND",
            `Action '${actionId}' not found on feed item '${itemId}'`,
            404,
          );
        }

        // TODO: Create a new conversation with context about the action.
        // This requires wiring SendMessageDeps into the route, which is
        // deferred to a follow-up PR. For now, return a stub response.
        const conversationId = `stub-${itemId}-${actionId}`;

        log.info(
          { itemId, actionId, label: action.label, title: item.title },
          "Feed action triggered (stub)",
        );

        return Response.json({ ok: true, conversationId });
      },
    },
  ];
}
