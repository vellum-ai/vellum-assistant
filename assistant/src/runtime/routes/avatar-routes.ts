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
import {
  BadRequestError,
  RouteError,
  ServiceUnavailableError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("avatar-routes");

export function publishAvatarUpdated(): void {
  const avatarPath = getAvatarImagePath();
  assistantEventHub
    .publish(
      buildAssistantEvent({
        type: "avatar_updated",
        avatarPath,
      }),
    )
    .catch((err) => {
      log.warn({ err }, "Failed to publish avatar_updated event");
    });
}

function handleGetCharacterComponents() {
  return getCharacterComponents();
}

function handleRenderFromTraits({ body }: RouteHandlerArgs) {
  const traits = body as CharacterTraits | undefined;

  if (
    !traits ||
    typeof traits !== "object" ||
    !traits.bodyShape ||
    !traits.eyeStyle ||
    !traits.color
  ) {
    throw new BadRequestError(
      "Missing required fields: bodyShape, eyeStyle, color",
    );
  }

  const result = writeTraitsAndRenderAvatar(traits);

  if (!result.ok) {
    switch (result.reason) {
      case "invalid_traits":
        throw new BadRequestError(result.message);
      case "native_unavailable":
        throw new ServiceUnavailableError(result.message);
      case "render_error":
        throw new RouteError(result.message, "INTERNAL_ERROR", 500);
    }
  }

  publishAvatarUpdated();
  return { ok: true };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "avatar_character_components",
    endpoint: "avatar/character-components",
    method: "GET",
    handler: handleGetCharacterComponents,
    summary: "Get character components",
    description: "Return available avatar character components.",
    tags: ["avatar"],
  },
  {
    operationId: "avatar_render_from_traits",
    endpoint: "avatar/render-from-traits",
    method: "POST",
    handler: handleRenderFromTraits,
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
  },
  {
    operationId: "notify_avatar_updated",
    endpoint: "avatar/notify-updated",
    method: "POST",
    handler: () => {
      publishAvatarUpdated();
      return { ok: true };
    },
    summary: "Notify avatar updated",
    description: "Publish an avatar_updated SSE event to connected clients.",
    tags: ["avatar"],
    responseBody: z.object({
      ok: z.boolean(),
    }),
  },
];
