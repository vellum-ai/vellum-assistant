import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
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
 * Renders avatar-image.png and character-ascii.txt from the given traits,
 * writing each file atomically.  Does NOT touch character-traits.json.
 *
 * Returns `true` if the ASCII sidecar was also written successfully.
 */
function renderAndWriteAvatarFiles(
  traits: CharacterTraits,
  avatarDir: string,
): boolean {
  const pngPath = join(avatarDir, "avatar-image.png");

  // Render PNG first so we fail before writing anything to disk.
  // Trait ID validation has already been performed by the caller.
  const pngBuffer = renderCharacterPng(
    traits.bodyShape,
    traits.eyeStyle,
    traits.color,
  );
  const pngTmp = `${pngPath}.${randomUUID()}.tmp`;
  writeFileSync(pngTmp, pngBuffer);
  renameSync(pngTmp, pngPath);

  // Render and write ASCII art — isolated so a failure here doesn't cause
  // the primary operation to report failure.
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
 * Validates trait IDs against the component set, then renders the PNG before
 * writing the traits file so that if rendering fails, neither file is modified.
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

  const avatarDir = join(getWorkspaceDir(), "data", "avatar");
  const traitsPath = join(avatarDir, "character-traits.json");

  try {
    mkdirSync(avatarDir, { recursive: true });

    // Render avatar files first — trait IDs are already validated above,
    // so errors here are genuine render failures (disk I/O, Resvg, etc.).
    const asciiWritten = renderAndWriteAvatarFiles(traits, avatarDir);

    // Write traits file atomically (after successful render)
    const traitsJson = JSON.stringify(traits, null, 2);
    const traitsTmp = `${traitsPath}.${randomUUID()}.tmp`;
    writeFileSync(traitsTmp, traitsJson);
    renameSync(traitsTmp, traitsPath);

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
