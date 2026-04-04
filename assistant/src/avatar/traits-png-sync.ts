import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { AVATAR_IMAGE_FILENAME, getAvatarDir } from "../util/platform.js";
import { renderCharacterAscii } from "./ascii-renderer.js";
import { getCharacterComponents } from "./character-components.js";
import { renderCharacterPng } from "./png-renderer.js";

const log = getLogger("traits-png-sync");

export interface CharacterTraits {
  bodyShape: string;
  eyeStyle: string;
  color: string;
}

export type TraitsSyncResult =
  | { ok: true; asciiWritten: boolean }
  | {
      ok: false;
      reason: "invalid_traits" | "render_error";
      message: string;
    };

/**
 * Renders avatar PNG and ASCII art into memory without touching the filesystem.
 * Call this before any disk writes so a render failure leaves all files untouched.
 */
function renderAvatarBuffers(traits: CharacterTraits): {
  pngBuffer: Buffer;
  asciiArt: string | null;
} {
  const pngBuffer = renderCharacterPng(
    traits.bodyShape,
    traits.eyeStyle,
    traits.color,
  );

  let asciiArt: string | null = null;
  try {
    asciiArt = renderCharacterAscii(
      traits.bodyShape,
      traits.eyeStyle,
      traits.color,
    );
  } catch (asciiErr) {
    log.warn(
      { err: asciiErr },
      "Failed to render ASCII art — will still write PNG and traits",
    );
  }

  return { pngBuffer, asciiArt };
}

/**
 * Writes pre-rendered avatar files (PNG + optional ASCII) to disk atomically.
 * Returns `true` if the ASCII sidecar was also written successfully.
 */
function writeAvatarFiles(
  avatarDir: string,
  pngBuffer: Buffer,
  asciiArt: string | null,
): boolean {
  const pngPath = join(avatarDir, AVATAR_IMAGE_FILENAME);
  const pngTmp = `${pngPath}.${randomUUID()}.tmp`;
  writeFileSync(pngTmp, pngBuffer);
  renameSync(pngTmp, pngPath);

  if (asciiArt == null) {
    return false;
  }

  try {
    const asciiPath = join(avatarDir, "character-ascii.txt");
    const asciiTmp = `${asciiPath}.${randomUUID()}.tmp`;
    writeFileSync(asciiTmp, asciiArt);
    renameSync(asciiTmp, asciiPath);
    return true;
  } catch (asciiErr) {
    log.warn(
      { err: asciiErr },
      "Failed to write ASCII sidecar — primary files still written",
    );
    return false;
  }
}

/**
 * Writes character-traits.json, regenerates avatar-image.png, and updates
 * character-ascii.txt in one atomic operation.  Accepts the trait values
 * directly so callers don't need to touch the filesystem first.
 *
 * Validates trait IDs against the component set, then renders into memory
 * before any disk writes.  Writes the traits file first, then the rendered
 * avatar files, so a render failure leaves all files untouched and a disk
 * failure after traits are written never leaves the PNG ahead of the traits.
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

  // Validate trait IDs against the known component set so that unknown values
  // are surfaced as input-validation errors (400) rather than server errors (500).
  const components = getCharacterComponents();
  const validBodyShapes = components.bodyShapes.map((b) => b.id);
  if (!validBodyShapes.includes(traits.bodyShape)) {
    return {
      ok: false,
      reason: "invalid_traits",
      message: `Unknown body shape: "${traits.bodyShape}". Valid IDs: ${validBodyShapes.join(", ")}`,
    };
  }
  const validEyeStyles = components.eyeStyles.map((e) => e.id);
  if (!validEyeStyles.includes(traits.eyeStyle)) {
    return {
      ok: false,
      reason: "invalid_traits",
      message: `Unknown eye style: "${traits.eyeStyle}". Valid IDs: ${validEyeStyles.join(", ")}`,
    };
  }
  const validColors = components.colors.map((c) => c.id);
  if (!validColors.includes(traits.color)) {
    return {
      ok: false,
      reason: "invalid_traits",
      message: `Unknown color: "${traits.color}". Valid IDs: ${validColors.join(", ")}`,
    };
  }

  const avatarDir = getAvatarDir();
  const traitsPath = join(avatarDir, "character-traits.json");

  try {
    mkdirSync(avatarDir, { recursive: true });

    // Phase 1: Render everything into memory — no disk writes yet.
    // If rendering fails, all files remain untouched.
    const { pngBuffer, asciiArt } = renderAvatarBuffers(traits);

    // Phase 2: Write traits file atomically first.
    const traitsJson = JSON.stringify(traits, null, 2);
    const traitsTmp = `${traitsPath}.${randomUUID()}.tmp`;
    writeFileSync(traitsTmp, traitsJson);
    renameSync(traitsTmp, traitsPath);

    // Phase 3: Write rendered avatar files to disk.
    // Traits are already committed, so a failure here leaves traits ahead of
    // the PNG — acceptable because the next render call will reconcile them.
    const asciiWritten = writeAvatarFiles(avatarDir, pngBuffer, asciiArt);

    log.info(
      {
        bodyShape: traits.bodyShape,
        eyeStyle: traits.eyeStyle,
        color: traits.color,
      },
      asciiWritten
        ? "Wrote character traits, regenerated avatar PNG, and updated ASCII art"
        : "Wrote character traits and regenerated avatar PNG",
    );
    return { ok: true, asciiWritten };
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
