import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

export const avatarRenameMigration: WorkspaceMigration = {
  id: "001-avatar-rename",
  description:
    "Rename custom-avatar.png → avatar-image.png and avatar-components.json → character-traits.json",
  run(workspaceDir: string): void {
    const avatarDir = join(workspaceDir, "data", "avatar");

    const oldImage = join(avatarDir, "custom-avatar.png");
    const newImage = join(avatarDir, "avatar-image.png");
    if (existsSync(oldImage) && !existsSync(newImage)) {
      renameSync(oldImage, newImage);
    }

    const oldTraits = join(avatarDir, "avatar-components.json");
    const newTraits = join(avatarDir, "character-traits.json");
    if (existsSync(oldTraits) && !existsSync(newTraits)) {
      renameSync(oldTraits, newTraits);
    }
  },
};
