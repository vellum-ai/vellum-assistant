import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeTraitsAndRenderAvatar } from "../../../../avatar/traits-png-sync.js";
import { readImageFile } from "../../../../tools/shared/filesystem/image-read.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { getWorkspaceDir } from "../../../../util/platform.js";

export async function run(
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const avatarPath = join(
    getWorkspaceDir(),
    "data",
    "avatar",
    "avatar-image.png",
  );

  if (!existsSync(avatarPath)) {
    // Check for native character traits and regenerate the static PNG
    const traitsPath = join(
      getWorkspaceDir(),
      "data",
      "avatar",
      "character-traits.json",
    );
    if (existsSync(traitsPath)) {
      try {
        const traits = JSON.parse(readFileSync(traitsPath, "utf-8"));
        const result = writeTraitsAndRenderAvatar(traits);
        if (result.ok && existsSync(avatarPath)) {
          return readImageFile(avatarPath);
        }
      } catch {
        // Fall through to default message
      }
    }
    return {
      content:
        "No avatar is currently set — no custom image and no character traits found.",
      isError: false,
    };
  }

  return readImageFile(avatarPath);
}
