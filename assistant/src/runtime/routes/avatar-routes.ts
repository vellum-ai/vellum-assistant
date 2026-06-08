import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

import { renderCharacterAscii } from "../../avatar/ascii-renderer.js";
import {
  type AvatarState,
  deriveStateFromLegacyFiles,
  readManifest,
  writeManifest,
} from "../../avatar/avatar-manifest.js";
import {
  clearAvatar,
  setCharacter,
  setImage,
} from "../../avatar/avatar-store.js";
import { getCharacterComponents } from "../../avatar/character-components.js";
import { updateIdentityAvatarSection } from "../../avatar/identity-avatar.js";
import {
  type CharacterTraits,
  TRAITS_FILENAME,
  writeTraitsAndRenderAvatar,
} from "../../avatar/traits-png-sync.js";
import { setPlatformBaseUrl } from "../../config/env.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { detectMediaType } from "../../tools/shared/filesystem/image-read.js";
import { generateAvatarImage } from "../../tools/system/avatar-generator.js";
import { getLogger } from "../../util/logger.js";
import {
  getAvatarDir,
  getAvatarImagePath,
  getWorkspaceDir,
} from "../../util/platform.js";
import { ACTOR_PRINCIPALS, LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { publishAvatarChanged } from "../sync/resource-sync-events.js";
import {
  BadRequestError,
  RouteError,
  ServiceUnavailableError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("avatar-routes");

function handleGetCharacterComponents() {
  return getCharacterComponents();
}

/**
 * Reads the manifest, self-healing once if it is absent.
 *
 * The migration (092) seeds `avatar.json` for every workspace, so the manifest
 * is normally present. If it is somehow missing (e.g. a workspace that predates
 * the manifest and skipped the migration), we derive state from the legacy
 * sidecar files. A *real* avatar (character/image) is persisted once so
 * subsequent reads hit the manifest directly; an empty (`none`) result is NOT
 * persisted, so an avatar-less workspace stays manifest-less and a later legacy
 * sidecar write is still picked up by the next self-heal (backward compat).
 */
function readManifestSelfHealing(): AvatarState {
  const manifest = readManifest();
  if (manifest) {
    return manifest;
  }
  const derived = deriveStateFromLegacyFiles();
  // Only persist a real avatar. Persisting `none` would shadow a later legacy
  // sidecar write behind a stale manifest (see migration 094 + clearAvatar).
  // Persist is best-effort: on a read-only / permission-restricted workspace the
  // write can throw. Swallow it so a GET still returns the derived state instead
  // of turning into a 500 — the next read simply self-heals again.
  if (derived.kind !== "none") {
    try {
      writeManifest(derived);
    } catch (err) {
      log.warn({ err }, "Failed to persist self-healed avatar manifest");
    }
  }
  return derived;
}

/**
 * Return the authoritative avatar render state.
 *
 * Reads the manifest (`avatar.json`). When the manifest is absent it is
 * self-healed once from the legacy sidecar files and persisted. Never 404s —
 * an empty workspace yields `{ kind: "none", traits: null, source: null,
 * image: null }`.
 */
function handleGetAvatarState() {
  return readManifestSelfHealing();
}

function handleRenderFromTraits({ body, headers }: RouteHandlerArgs) {
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

  const result = setCharacter(traits);

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
  publishAvatarChanged(headers?.["x-vellum-client-id"]?.trim() || undefined);
  return { ok: true };
}

async function handleGenerateAvatar({ body, headers }: RouteHandlerArgs) {
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

  const result = await generateAvatarImage(description);
  if (result.isError || !result.pngBuffer) {
    throw new ServiceUnavailableError(result.content);
  }

  // Route through the store: atomically writes the PNG, removes the now-stale
  // character sidecars (traits + ASCII), and records an AI-sourced manifest.
  setImage(result.pngBuffer, "ai");

  updateIdentityAvatarSection(null, log);
  publishAvatarChanged(headers?.["x-vellum-client-id"]?.trim() || undefined);
  return { ok: true, message: result.content };
}

/**
 * Accept a base64-encoded image and set it as the avatar. Replaces the web
 * client's prior two-call `workspace/write` + `workspace/delete` dance with a
 * single server-authoritative endpoint: the store atomically writes the PNG,
 * clears the character sidecars, and records an `image` manifest.
 */
function handleUploadAvatarImage({ body, headers }: RouteHandlerArgs) {
  const payload = body as Record<string, unknown> | undefined;
  const content = payload?.content;
  const encoding = payload?.encoding;

  if (typeof content !== "string" || content.length === 0) {
    throw new BadRequestError("content (base64 string) is required");
  }
  if (encoding !== undefined && encoding !== "base64") {
    throw new BadRequestError('encoding must be "base64"');
  }

  // Strictly validate the base64 BEFORE decoding. `Buffer.from(.., "base64")`
  // silently drops characters outside the alphabet, so a valid image prefix
  // followed by garbage would decode to a truncated/corrupt buffer that still
  // passes the magic-byte sniff below — accepting a corrupt avatar. Same strict
  // pattern used by stt-routes / live-voice (tolerating surrounding whitespace).
  const normalized = content.replace(/\s+/g, "");
  if (
    normalized.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      normalized,
    )
  ) {
    throw new BadRequestError("content is not valid base64-encoded image data");
  }

  const buffer = Buffer.from(normalized, "base64");
  if (detectMediaType(buffer) === null) {
    throw new BadRequestError(
      "content must be a PNG, JPEG, GIF, or WEBP image",
    );
  }

  // Route through the store: atomically writes the PNG, removes the now-stale
  // character sidecars (traits + ASCII), and records an uploaded-image manifest.
  setImage(buffer, "upload");

  updateIdentityAvatarSection(null, log);
  publishAvatarChanged(headers?.["x-vellum-client-id"]?.trim() || undefined);
  return { ok: true };
}

function handleSetAvatar({ body, headers }: RouteHandlerArgs) {
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
  if (
    normalized !== workspaceDir &&
    !normalized.startsWith(workspaceDir + "/")
  ) {
    throw new BadRequestError(
      "imagePath must resolve inside the workspace directory",
    );
  }
  if (!existsSync(normalized)) {
    throw new BadRequestError(`Image file not found: ${normalized}`);
  }

  // Route through the store so traits sidecars are cleared and the manifest is
  // recorded as an uploaded image atomically (no more stale both-files state).
  setImage(readFileSync(normalized), "upload");

  updateIdentityAvatarSection(null, log);
  publishAvatarChanged(headers?.["x-vellum-client-id"]?.trim() || undefined);
  return { ok: true };
}

function handleRemoveAvatar({ headers }: RouteHandlerArgs) {
  // `hadAvatar` must reflect whether *any* avatar was configured before the
  // clear — not just a rendered PNG. A character-only workspace (traits present,
  // no PNG) is still an avatar, and clearAvatar() deletes its traits/ascii too.
  // Derive from the manifest (self-healing on a manifest-miss) and treat any
  // non-"none" kind as hadAvatar.
  const hadAvatar = readManifestSelfHealing().kind !== "none";

  // Clear everything to a manifest-consistent kind:"none". Semantic change
  // (intentional): traits no longer persist alongside an image, so there is
  // nothing to revert to — the legacy "re-render character from traits" branch
  // has been removed. avatar/remove is now a plain clear, reachable only via
  // CLI/host.
  clearAvatar();

  updateIdentityAvatarSection(
    "Default character avatar (no custom image set)",
    log,
  );
  publishAvatarChanged(headers?.["x-vellum-client-id"]?.trim() || undefined);
  return { ok: true, hadAvatar };
}

function handleGetAvatar({ queryParams, body }: RouteHandlerArgs) {
  const format = (queryParams?.format ??
    (body as Record<string, unknown>)?.format ??
    "path") as string;

  if (format !== "path" && format !== "base64") {
    throw new BadRequestError(
      `Invalid format: "${format}". Must be "path" or "base64".`,
    );
  }

  // Resolve precedence from the manifest so this raster accessor (CLI / dock /
  // notifications) agrees with macOS/web rather than picking image-first off
  // file existence. For both `character` and `image` the derived raster is the
  // same on-disk PNG; only the precedence is manifest-driven. Self-heals once
  // on manifest-miss so we never re-infer from legacy files per request.
  const state = readManifestSelfHealing();

  if (state.kind === "none") {
    return { exists: false };
  }

  const avatarPath = getAvatarImagePath();

  // For a character, the rendered PNG normally already exists on disk. Keep the
  // existing safety net: if it's missing, re-render it from the persisted traits
  // so the accessor still returns a raster.
  if (state.kind === "character" && !existsSync(avatarPath) && state.traits) {
    try {
      writeTraitsAndRenderAvatar(state.traits);
    } catch {
      // Best-effort
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

  const traitsPath = join(getAvatarDir(), TRAITS_FILENAME);
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGetCharacterComponents,
    summary: "Get character components",
    description: "Return available avatar character components.",
    tags: ["avatar"],
    responseBody: z.object({
      bodyShapes: z.array(
        z.object({
          id: z.string(),
          viewBox: z.object({ width: z.number(), height: z.number() }),
          faceCenter: z.object({ x: z.number(), y: z.number() }),
          svgPath: z.string(),
        }),
      ),
      eyeStyles: z.array(
        z.object({
          id: z.string(),
          sourceViewBox: z.object({ width: z.number(), height: z.number() }),
          eyeCenter: z.object({ x: z.number(), y: z.number() }),
          paths: z.array(z.object({ svgPath: z.string(), color: z.string() })),
        }),
      ),
      colors: z.array(z.object({ id: z.string(), hex: z.string() })),
      faceCenterOverrides: z.array(
        z.object({
          bodyShape: z.string(),
          eyeStyle: z.string(),
          faceCenter: z.object({ x: z.number(), y: z.number() }),
        }),
      ),
    }),
  },
  {
    operationId: "avatar_get_state",
    endpoint: "avatar/state",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGetAvatarState,
    summary: "Get avatar state",
    description:
      "Return the authoritative avatar render mode (character, image, or none).",
    tags: ["avatar"],
    responseBody: z.object({
      kind: z.enum(["character", "image", "none"]),
      traits: z
        .object({
          bodyShape: z.string(),
          eyeStyle: z.string(),
          color: z.string(),
        })
        .nullable(),
      source: z.enum(["builder", "upload", "ai"]).nullable(),
      image: z
        .object({
          updatedAt: z.string(),
          etag: z.string(),
        })
        .nullable(),
    }),
  },
  {
    operationId: "avatar_render_from_traits",
    endpoint: "avatar/render-from-traits",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: ({ headers }: RouteHandlerArgs) => {
      publishAvatarChanged(
        headers?.["x-vellum-client-id"]?.trim() || undefined,
      );
      return { ok: true };
    },
    summary: "Notify avatar updated",
    description: "Publish avatar change notifications to connected clients.",
    tags: ["avatar"],
    responseBody: z.object({
      ok: z.boolean(),
    }),
  },
  {
    operationId: "avatar_generate",
    endpoint: "avatar/generate",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleSetAvatar,
    summary: "Set avatar from image file",
    description: "Copy an image file to the avatar location.",
    tags: ["avatar"],
    requestBody: z.object({ imagePath: z.string() }),
    responseBody: z.object({ ok: z.boolean() }),
  },
  {
    operationId: "avatar_upload_image",
    endpoint: "avatar/image",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleUploadAvatarImage,
    summary: "Upload avatar image",
    description:
      "Upload a base64-encoded image as the avatar; writes the PNG and clears character traits atomically.",
    tags: ["avatar"],
    requestBody: z.object({
      content: z.string(),
      encoding: z.literal("base64").optional(),
    }),
    responseBody: z.object({ ok: z.boolean() }),
  },
  {
    operationId: "avatar_remove",
    endpoint: "avatar/remove",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGetAvatar,
    summary: "Get current avatar",
    description: "Retrieve the current avatar as a file path or base64 string.",
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
