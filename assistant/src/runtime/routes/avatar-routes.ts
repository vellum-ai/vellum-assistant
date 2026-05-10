import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { renderCharacterAscii } from "../../avatar/ascii-renderer.js";
import { getCharacterComponents } from "../../avatar/character-components.js";
import { updateIdentityAvatarSection } from "../../avatar/identity-avatar.js";
import {
  type CharacterTraits,
  writeTraitsAndRenderAvatar,
} from "../../avatar/traits-png-sync.js";
import { setPlatformBaseUrl } from "../../config/env.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { generateAndSaveAvatar } from "../../tools/system/avatar-generator.js";
import { getLogger } from "../../util/logger.js";
import {
  getAvatarDir,
  getAvatarImagePath,
  getWorkspaceDir,
} from "../../util/platform.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import {
  BadRequestError,
  RouteError,
  ServiceUnavailableError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("avatar-routes");

function publishAvatarUpdated(): void {
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

  updateIdentityAvatarSection(null, log);
  publishAvatarUpdated();
  return { ok: true };
}

async function handleGenerateAvatar({ body }: RouteHandlerArgs) {
  const description = (body as Record<string, unknown>)?.description as
    | string
    | undefined;
  if (!description) {
    throw new BadRequestError("description is required");
  }

  // Rehydrate platform base URL from credential store
  try {
    const key = credentialKey("vellum", "platform_base_url");
    const persisted = await getSecureKeyAsync(key);
    if (persisted) {
      setPlatformBaseUrl(persisted);
    }
  } catch {
    // Non-fatal
  }

  const result = await generateAndSaveAvatar(description);
  if (result.isError) {
    throw new ServiceUnavailableError(result.content);
  }

  // Remove native character files since AI-generated image takes precedence
  const avatarDir = getAvatarDir();
  const traitsPath = join(avatarDir, "character-traits.json");
  const asciiPath = join(avatarDir, "character-ascii.txt");
  try {
    if (existsSync(traitsPath)) unlinkSync(traitsPath);
    if (existsSync(asciiPath)) unlinkSync(asciiPath);
  } catch {
    // Best-effort
  }

  updateIdentityAvatarSection(null, log);
  publishAvatarUpdated();
  return { ok: true, message: result.content };
}

function handleSetAvatar({ body }: RouteHandlerArgs) {
  const imagePath = (body as Record<string, unknown>)?.imagePath as
    | string
    | undefined;
  if (!imagePath) {
    throw new BadRequestError("imagePath is required");
  }
  // Path safety: imagePath must resolve inside the workspace dir.
  // Without this guard an authenticated caller with settings.write could
  // pass /etc/passwd or other host paths and exfiltrate via avatar_get.
  const workspaceDir = getWorkspaceDir();
  const normalized = resolve(imagePath);
  if (normalized !== workspaceDir && !normalized.startsWith(workspaceDir + "/")) {
    throw new BadRequestError(
      "imagePath must resolve inside the workspace directory",
    );
  }
  if (!existsSync(normalized)) {
    throw new BadRequestError(`Image file not found: ${normalized}`);
  }

  const avatarPath = getAvatarImagePath();
  mkdirSync(dirname(avatarPath), { recursive: true });
  copyFileSync(normalized, avatarPath);

  updateIdentityAvatarSection(null, log);
  publishAvatarUpdated();
  return { ok: true };
}

function handleRemoveAvatar(_args: RouteHandlerArgs) {
  const avatarPath = getAvatarImagePath();

  if (!existsSync(avatarPath)) {
    return { ok: true, hadAvatar: false };
  }

  unlinkSync(avatarPath);

  // Regenerate character PNG from traits if available
  const traitsPath = join(getAvatarDir(), "character-traits.json");
  if (existsSync(traitsPath)) {
    try {
      const traits = JSON.parse(
        readFileSync(traitsPath, "utf-8"),
      ) as CharacterTraits;
      writeTraitsAndRenderAvatar(traits);
    } catch {
      // Best-effort
    }
  }

  updateIdentityAvatarSection(
    "Default character avatar (no custom image set)",
    log,
  );
  publishAvatarUpdated();
  return { ok: true, hadAvatar: true };
}

function handleGetAvatar({ queryParams, body }: RouteHandlerArgs) {
  const format = (
    queryParams?.format ??
    (body as Record<string, unknown>)?.format ??
    "path"
  ) as string;

  if (format !== "path" && format !== "base64") {
    throw new BadRequestError(
      `Invalid format: "${format}". Must be "path" or "base64".`,
    );
  }

  const avatarPath = getAvatarImagePath();

  if (!existsSync(avatarPath)) {
    const traitsPath = join(getAvatarDir(), "character-traits.json");
    if (existsSync(traitsPath)) {
      try {
        const traits = JSON.parse(
          readFileSync(traitsPath, "utf-8"),
        ) as CharacterTraits;
        writeTraitsAndRenderAvatar(traits);
      } catch {
        // Best-effort
      }
    }
  }

  if (!existsSync(avatarPath)) {
    return { exists: false };
  }

  if (format === "path") {
    return { exists: true, path: avatarPath };
  }
  return { exists: true, base64: readFileSync(avatarPath).toString("base64") };
}

function handleCharacterAscii({ queryParams, body }: RouteHandlerArgs) {
  const widthRaw =
    queryParams?.width ?? (body as Record<string, unknown>)?.width ?? "60";
  const widthStr = String(widthRaw);

  if (!/^\d+$/.test(widthStr)) {
    throw new BadRequestError(
      `Invalid width: "${widthStr}". Must be a positive integer.`,
    );
  }

  const width = parseInt(widthStr, 10);
  if (!Number.isFinite(width) || width < 1) {
    throw new BadRequestError(
      `Invalid width: "${widthStr}". Must be a positive integer.`,
    );
  }

  const traitsPath = join(getAvatarDir(), "character-traits.json");
  if (!existsSync(traitsPath)) {
    throw new BadRequestError(
      "No native character set. Use 'assistant avatar character update' first.",
    );
  }

  let traits: CharacterTraits;
  try {
    traits = JSON.parse(readFileSync(traitsPath, "utf-8")) as CharacterTraits;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BadRequestError(`Failed to read character traits: ${message}`);
  }

  const ascii = renderCharacterAscii(
    traits.bodyShape,
    traits.eyeStyle,
    traits.color,
    width,
  );
  return { ascii };
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
  {
    operationId: "avatar_generate",
    endpoint: "avatar/generate",
    method: "POST",
    handler: handleGenerateAvatar,
    summary: "Generate AI avatar",
    description: "Generate an AI avatar from a text description and save it.",
    tags: ["avatar"],
    requestBody: z.object({ description: z.string() }),
    responseBody: z.object({ ok: z.boolean(), message: z.string() }),
  },
  {
    operationId: "avatar_set",
    endpoint: "avatar/set",
    method: "POST",
    handler: handleSetAvatar,
    summary: "Set avatar from image file",
    description: "Copy an image file to the avatar location.",
    tags: ["avatar"],
    requestBody: z.object({ imagePath: z.string() }),
    responseBody: z.object({ ok: z.boolean() }),
  },
  {
    operationId: "avatar_remove",
    endpoint: "avatar/remove",
    method: "POST",
    handler: handleRemoveAvatar,
    summary: "Remove custom avatar",
    description:
      "Remove the custom avatar image and restore the character default.",
    tags: ["avatar"],
    responseBody: z.object({ ok: z.boolean(), hadAvatar: z.boolean() }),
  },
  {
    operationId: "avatar_get",
    endpoint: "avatar/get",
    method: "GET",
    handler: handleGetAvatar,
    summary: "Get current avatar",
    description:
      "Retrieve the current avatar as a file path or base64 string.",
    tags: ["avatar"],
    queryParams: [
      {
        name: "format",
        schema: { type: "string" },
        description: '"path" or "base64"',
      },
    ],
  },
  {
    operationId: "avatar_character_ascii",
    endpoint: "avatar/character/ascii",
    method: "GET",
    handler: handleCharacterAscii,
    summary: "Render character as ASCII art",
    description: "Render the current native character as ASCII art.",
    tags: ["avatar"],
    queryParams: [
      {
        name: "width",
        schema: { type: "string" },
        description: "Width in characters (default 60)",
      },
    ],
    responseBody: z.object({ ascii: z.string() }),
  },
];
