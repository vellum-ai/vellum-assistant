import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { renderCharacterPng } from "./png-renderer.js";

const log = getLogger("traits-png-sync");

interface CharacterTraits {
  bodyShape: string;
  eyeStyle: string;
  color: string;
}

/**
 * Reads character-traits.json from the avatar directory and regenerates
 * avatar-image.png to match. Called after traits are written to disk.
 * Returns true if PNG was generated, false if traits file is missing/invalid.
 */
export function syncTraitsToPng(): boolean {
  const avatarDir = join(getWorkspaceDir(), "data", "avatar");
  const traitsPath = join(avatarDir, "character-traits.json");
  const pngPath = join(avatarDir, "avatar-image.png");

  let traits: CharacterTraits;
  try {
    const raw = readFileSync(traitsPath, "utf-8");
    traits = JSON.parse(raw) as CharacterTraits;
  } catch {
    return false;
  }

  if (!traits.bodyShape || !traits.eyeStyle || !traits.color) {
    log.warn({ traits }, "Invalid character traits — missing required fields");
    return false;
  }

  try {
    const pngBuffer = renderCharacterPng(
      traits.bodyShape,
      traits.eyeStyle,
      traits.color,
    );
    mkdirSync(avatarDir, { recursive: true });
    const tmpPath = `${pngPath}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, pngBuffer);
    renameSync(tmpPath, pngPath);
    log.info(
      {
        bodyShape: traits.bodyShape,
        eyeStyle: traits.eyeStyle,
        color: traits.color,
      },
      "Regenerated avatar PNG from character traits",
    );
    return true;
  } catch (err) {
    log.error({ err }, "Failed to render avatar PNG from traits");
    return false;
  }
}
