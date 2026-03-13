import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { generateAvatar } from "../../media/avatar-router.js";
import { mapGeminiError } from "../../media/gemini-image-service.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("avatar-generator");

const TOOL_NAME = "set_avatar";

/** Canonical path where the custom avatar PNG is stored. */
function getAvatarPath(): string {
  return join(getWorkspaceDir(), "data", "avatar", "custom-avatar.png");
}

export const setAvatarTool: Tool = {
  name: TOOL_NAME,
  description:
    "Generate a custom avatar image from a text description. " +
    "Saves the result as the assistant's avatar.",
  category: "system",
  defaultRiskLevel: RiskLevel.Low,

  getDefinition(): ToolDefinition {
    return {
      name: TOOL_NAME,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description:
              "A text description of the desired avatar appearance, " +
              'e.g. "a friendly purple cat with green eyes wearing a tiny hat".',
          },
        },
        required: ["description"],
      },
    };
  },

  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const description = input.description;
    if (typeof description !== "string" || description.trim() === "") {
      return {
        content:
          "Error: description is required and must be a non-empty string.",
        isError: true,
      };
    }

    try {
      log.info({ description: description.trim() }, "Generating avatar");

      const prompt =
        `Create an avatar image based on this description: ${description.trim()}\n\n` +
        "Style: cute, friendly, work-safe illustration. " +
        "Vibrant but soft colors. Simple and recognizable at small sizes (28px). " +
        "Circular or rounded composition filling the canvas. " +
        "Subtle background color (not white or transparent).";

      const result = await generateAvatar(prompt);
      if (!result.imageBase64) {
        return {
          content: "Error: No image data returned. Please try again.",
          isError: true,
        };
      }
      const pngBuffer = Buffer.from(result.imageBase64, "base64");

      const avatarPath = getAvatarPath();
      const avatarDir = dirname(avatarPath);

      const tmpPath = `${avatarPath}.${randomUUID()}.tmp`;
      mkdirSync(avatarDir, { recursive: true });
      writeFileSync(tmpPath, pngBuffer);
      renameSync(tmpPath, avatarPath);

      log.info({ avatarPath }, "Avatar saved successfully");

      // Side-effect hook in tool-side-effects.ts broadcasts avatar_updated to all clients.

      return {
        content: "Avatar updated! Your new avatar will appear shortly.",
        isError: false,
      };
    } catch (error) {
      const message = mapGeminiError(error);
      log.error({ error: message }, "Avatar generation failed");
      return {
        content: `Avatar generation failed: ${message}`,
        isError: true,
      };
    }
  },
};
