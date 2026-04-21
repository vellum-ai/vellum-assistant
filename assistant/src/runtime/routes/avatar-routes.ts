import { z } from "zod";

import { getCharacterComponents } from "../../avatar/character-components.js";
import {
  type CharacterTraits,
  writeTraitsAndRenderAvatar,
} from "../../avatar/traits-png-sync.js";
import { getLogger } from "../../util/logger.js";
import { getAvatarImagePath } from "../../util/platform.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { httpError, type HttpErrorCode } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("avatar-routes");

function publishAvatarUpdated(): void {
  const avatarPath = getAvatarImagePath();
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
      summary: "Get character components",
      description: "Return available avatar character components.",
      tags: ["avatar"],
      handler: () => Response.json(getCharacterComponents()),
    },
    {
      endpoint: "avatar/render-from-traits",
      method: "POST",
      summary: "Render avatar from traits",
      description: "Write character traits and render an avatar PNG.",
      tags: ["avatar"],
      requestBody: z.object({
        bodyShape: z.string(),
        eyeStyle: z.string(),
        color: z.string(),
      }),
      responseBody: z.object({
        ok: z.boolean(),
      }),
      handler: async ({ req }) => {
        let body: CharacterTraits;
        try {
          body = (await req.json()) as CharacterTraits;
        } catch {
          return httpError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        if (
          !body ||
          typeof body !== "object" ||
          !body.bodyShape ||
          !body.eyeStyle ||
          !body.color
        ) {
          return httpError(
            "BAD_REQUEST",
            "Missing required fields: bodyShape, eyeStyle, color",
            400,
          );
        }

        const result = writeTraitsAndRenderAvatar(body);

        if (!result.ok) {
          // Map each failure reason to an HTTP status that reflects its
          // cause: invalid inputs → 400, missing native dependency → 503,
          // everything else → 500.
          let status: number;
          let code: HttpErrorCode;
          switch (result.reason) {
            case "invalid_traits":
              status = 400;
              code = "BAD_REQUEST";
              break;
            case "native_unavailable":
              status = 503;
              code = "SERVICE_UNAVAILABLE";
              break;
            case "render_error":
              status = 500;
              code = "INTERNAL_ERROR";
              break;
          }
          return httpError(code, result.message, status);
        }

        publishAvatarUpdated();
        return Response.json({ ok: true });
      },
    },
  ];
}
