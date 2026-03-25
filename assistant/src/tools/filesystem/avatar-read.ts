import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeTraitsAndRenderAvatar } from "../../avatar/traits-png-sync.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { registerTool } from "../registry.js";
import { readImageFile } from "../shared/filesystem/image-read.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

class AvatarReadTool implements Tool {
  name = "get_avatar";
  description =
    "Read and return the current avatar image so the user can see it. Use this when the user asks to see, view, or show their avatar. Returns the image inline.";
  category = "filesystem";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          activity: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are doing, shown to the user as a status update.",
          },
        },
      },
    };
  }

  async execute(
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
}

export const avatarReadTool = new AvatarReadTool();
registerTool(avatarReadTool);
