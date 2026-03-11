import { extname } from "node:path";

import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { registerTool } from "../registry.js";
import {
  IMAGE_EXTENSIONS,
  readImageFile,
} from "../shared/filesystem/image-read.js";
import { sandboxPolicy } from "../shared/filesystem/path-policy.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

class ViewImageTool implements Tool {
  name = "view_image";
  description =
    "Read an image file from the filesystem and return it for visual analysis. Supports JPEG, PNG, GIF, and WebP.";
  category = "filesystem";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "The path to the image file (absolute or relative to working directory)",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are viewing and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
        required: ["path"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const rawPath = input.path as string;
    if (!rawPath || typeof rawPath !== "string") {
      return {
        content: "Error: path is required and must be a string",
        isError: true,
      };
    }

    const pathCheck = sandboxPolicy(rawPath, context.workingDir);
    if (!pathCheck.ok) {
      return { content: `Error: ${pathCheck.error}`, isError: true };
    }
    const resolved = pathCheck.resolved;

    const ext = extname(resolved).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      const supported = [...IMAGE_EXTENSIONS].join(", ");
      return {
        content: `Error: unsupported image format "${ext}". Supported: ${supported}`,
        isError: true,
      };
    }

    return readImageFile(resolved);
  }
}

registerTool(new ViewImageTool());
