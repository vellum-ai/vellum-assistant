import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { routedGenerateAvatar } from "../../media/avatar-router.js";
import { ManagedAvatarError } from "../../media/avatar-types.js";
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
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are creating and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
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

      const result = await routedGenerateAvatar(prompt);
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

      log.info(
        {
          avatarPath,
          pathUsed: result.pathUsed,
          correlationId: result.correlationId,
        },
        "Avatar saved successfully",
      );

      // Side-effect hook in tool-side-effects.ts broadcasts avatar_updated to all clients.

      return {
        content: "Avatar updated! Your new avatar will appear shortly.",
        isError: false,
      };
    } catch (error) {
      if (error instanceof ManagedAvatarError) {
        if (error.statusCode === 429) {
          log.warn(
            { correlationId: error.correlationId },
            "Avatar generation rate limited",
          );
          return {
            content:
              "Avatar generation is rate limited. Please wait and try again.",
            isError: true,
          };
        }
        if (error.statusCode === 503) {
          log.warn(
            { correlationId: error.correlationId },
            "Avatar generation service unavailable",
          );
          return {
            content: "Avatar generation service is temporarily unavailable.",
            isError: true,
          };
        }
        const detail =
          error.message || "Avatar generation failed. Please try again.";
        log.error(
          { error: detail, correlationId: error.correlationId },
          "Managed avatar generation failed",
        );
        return {
          content: `Avatar generation failed: ${detail}`,
          isError: true,
        };
      }

      const message = mapGeminiError(error);
      log.error({ error: message }, "Avatar generation failed");
      return {
        content: `Avatar generation failed: ${message}`,
        isError: true,
      };
    }
  },
};
