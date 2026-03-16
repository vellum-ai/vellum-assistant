import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { renderCharacterAscii } from "./ascii-renderer.js";
import { renderCharacterPng } from "./png-renderer.js";

const log = getLogger("traits-png-sync");

export interface CharacterTraits {
  bodyShape: string;
  eyeStyle: string;
  color: string;
}

export type TraitsSyncResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_traits" | "invalid_traits" | "render_error";
      message: string;
    };

/**
 * Writes character-traits.json, regenerates avatar-image.png, and updates
 * character-ascii.txt in one atomic operation.  Accepts the trait values
 * directly so callers don't need to touch the filesystem first.
 */
export function writeTraitsAndRenderAvatar(
  traits: CharacterTraits,
): TraitsSyncResult {
  if (
    !traits ||
    typeof traits !== "object" ||
    !traits.bodyShape ||
    !traits.eyeStyle ||
    !traits.color
  ) {
    log.warn({ traits }, "Invalid character traits — missing required fields");
    return {
      ok: false,
      reason: "invalid_traits",
      message: "Missing required fields: bodyShape, eyeStyle, color",
    };
  }

  const avatarDir = join(getWorkspaceDir(), "data", "avatar");
  const traitsPath = join(avatarDir, "character-traits.json");
  const pngPath = join(avatarDir, "avatar-image.png");

  try {
    mkdirSync(avatarDir, { recursive: true });

    // Write traits file atomically
    const traitsJson = JSON.stringify(traits, null, 2);
    const traitsTmp = `${traitsPath}.${randomUUID()}.tmp`;
    writeFileSync(traitsTmp, traitsJson);
    renameSync(traitsTmp, traitsPath);

    // Render and write PNG atomically
    const pngBuffer = renderCharacterPng(
      traits.bodyShape,
      traits.eyeStyle,
      traits.color,
    );
    const pngTmp = `${pngPath}.${randomUUID()}.tmp`;
    writeFileSync(pngTmp, pngBuffer);
    renameSync(pngTmp, pngPath);

    // Render and write ASCII art atomically — isolated so a failure here
    // doesn't cause the primary operation (traits JSON + PNG) to report failure.
    try {
      const asciiPath = join(avatarDir, "character-ascii.txt");
      const asciiArt = renderCharacterAscii(
        traits.bodyShape,
        traits.eyeStyle,
        traits.color,
      );
      const asciiTmp = `${asciiPath}.${randomUUID()}.tmp`;
      writeFileSync(asciiTmp, asciiArt);
      renameSync(asciiTmp, asciiPath);
    } catch (asciiErr) {
      log.warn(
        { err: asciiErr },
        "Failed to write ASCII sidecar — primary files still written",
      );
    }

    log.info(
      {
        bodyShape: traits.bodyShape,
        eyeStyle: traits.eyeStyle,
        color: traits.color,
      },
      "Wrote character traits, regenerated avatar PNG, and updated ASCII art",
    );
    return { ok: true };
  } catch (err) {
    log.error({ err }, "Failed to write traits / render avatar");
    return {
      ok: false,
      reason: "render_error",
      message:
        err instanceof Error ? err.message : "Failed to render avatar PNG",
    };
  }
}

/**
 * Reads character-traits.json from the avatar directory and regenerates
 * avatar-image.png and character-ascii.txt to match. Kept for backward
 * compatibility (e.g. the client-side file watcher triggers this path).
 */
export function syncTraitsToAvatar(): TraitsSyncResult {
  const traitsPath = join(
    getWorkspaceDir(),
    "data",
    "avatar",
    "character-traits.json",
  );

  let traits: unknown;
  try {
    const raw = readFileSync(traitsPath, "utf-8");
    traits = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: "missing_traits",
      message: "No valid character-traits.json found",
    };
  }

  if (!traits || typeof traits !== "object") {
    return {
      ok: false,
      reason: "invalid_traits",
      message: "character-traits.json does not contain a valid object",
    };
  }

  return writeTraitsAndRenderAvatar(traits as CharacterTraits);
}
