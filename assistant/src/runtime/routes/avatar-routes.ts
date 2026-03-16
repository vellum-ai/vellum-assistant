import { join } from "node:path";

import { getCharacterComponents } from "../../avatar/character-components.js";
import {
  type CharacterTraits,
  syncTraitsToAvatar,
  type TraitsSyncResult,
  writeTraitsAndRenderAvatar,
} from "../../avatar/traits-png-sync.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("avatar-routes");

function publishAvatarUpdated(): void {
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
}

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
      handler: async ({ req }) => {
        let result: TraitsSyncResult;

        // If the request includes a JSON body with traits, write the traits
        // file and render the PNG in one atomic operation.  Otherwise fall
        // back to reading the existing character-traits.json from disk
        // (backward-compat path).
        const contentType = req.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          let body: CharacterTraits;
          try {
            body = (await req.json()) as CharacterTraits;
          } catch {
            return httpError("BAD_REQUEST", "Invalid JSON body", 400);
          }

          if (!body.bodyShape || !body.eyeStyle || !body.color) {
            return httpError(
              "BAD_REQUEST",
              "Missing required fields: bodyShape, eyeStyle, color",
              400,
            );
          }

          result = writeTraitsAndRenderAvatar(body);
        } else {
          result = syncTraitsToAvatar();
        }

        if (!result.ok) {
          const status = result.reason === "render_error" ? 500 : 400;
          const code =
            result.reason === "render_error" ? "INTERNAL_ERROR" : "BAD_REQUEST";
          return httpError(code, result.message, status);
        }

        publishAvatarUpdated();
        return Response.json({ ok: true });
      },
    },
  ];
}
