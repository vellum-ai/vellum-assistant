import { join } from "node:path";

import { getCharacterComponents } from "../../avatar/character-components.js";
import { syncTraitsToPng } from "../../avatar/traits-png-sync.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("avatar-routes");

export function avatarRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "avatar/character-components",
      method: "GET",
      handler: () => Response.json(getCharacterComponents()),
    },
    {
      endpoint: "avatar/render-from-traits",
      method: "POST",
      handler: () => {
        const success = syncTraitsToPng();
        if (!success) {
          return httpError(
            "BAD_REQUEST",
            "No valid character-traits.json found",
            400,
          );
        }

        // Notify connected clients to reload avatar
        const avatarPath = join(
          getWorkspaceDir(),
          "data",
          "avatar",
          "avatar-image.png",
        );
        assistantEventHub
          .publish(
            buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
              type: "avatar_updated",
              avatarPath,
            }),
          )
          .catch((err) => {
            log.warn({ err }, "Failed to publish avatar_updated event");
          });

        return Response.json({ ok: true });
      },
    },
  ];
}
