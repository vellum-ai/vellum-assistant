import { existsSync } from "node:fs";
import { join } from "node:path";

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
    return {
      content:
        "No avatar image is currently set. The assistant is using the default character avatar.",
      isError: false,
    };
  }

  return readImageFile(avatarPath);
}
