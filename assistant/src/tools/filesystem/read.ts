import { extname } from "node:path";

import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { registerTool } from "../registry.js";
import { FileSystemOps } from "../shared/filesystem/file-ops-service.js";
import {
  IMAGE_EXTENSIONS,
  readImageFile,
} from "../shared/filesystem/image-read.js";
import { sandboxPolicy } from "../shared/filesystem/path-policy.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

class FileReadTool implements Tool {
  name = "file_read";
  description =
    "Read the contents of a file. For image files (JPEG, PNG, GIF, WebP), returns the image for visual analysis. Always use this tool (not host_file_read) for workspace files under .vellum.";
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
              "The path to the file to read (absolute or relative to working directory)",
          },
          offset: {
            type: "number",
            description: "Line number to start reading from (1-indexed)",
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to read",
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

    // For image files, delegate to the shared image reader.
    const ext = extname(rawPath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      const pathCheck = sandboxPolicy(rawPath, context.workingDir);
      if (!pathCheck.ok) {
        return {
          content: `Error: ${pathCheck.error}. To read files outside the workspace, use the host_file_read tool instead.`,
          isError: true,
        };
      }
      return readImageFile(pathCheck.resolved);
    }

    const ops = new FileSystemOps((path, opts) =>
      sandboxPolicy(path, context.workingDir, opts),
    );

    const result = ops.readFileSafe({
      path: rawPath,
      offset: typeof input.offset === "number" ? input.offset : undefined,
      limit: typeof input.limit === "number" ? input.limit : undefined,
    });

    if (!result.ok) {
      const { error } = result;
      switch (error.code) {
        case "NOT_A_FILE":
          return {
            content: `Error: ${error.path} is a directory, not a file`,
            isError: true,
          };
        case "IO_ERROR":
          return {
            content: `Error reading file "${rawPath}": ${error.message}`,
            isError: true,
          };
        default: {
          const hint =
            error.code === "PATH_OUT_OF_BOUNDS"
              ? ". To read files outside the workspace, use the host_file_read tool instead."
              : "";
          return {
            content: `Error: ${error.message}${hint}`,
            isError: true,
          };
        }
      }
    }

    return { content: result.value.content, isError: false };
  }
}

export const fileReadTool = new FileReadTool();
registerTool(fileReadTool);
