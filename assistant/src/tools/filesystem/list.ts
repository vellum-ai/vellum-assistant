import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { registerTool } from "../registry.js";
import { FileSystemOps } from "../shared/filesystem/file-ops-service.js";
import { sandboxPolicy } from "../shared/filesystem/path-policy.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

class FileListTool implements Tool {
  name = "file_list";
  description =
    "List the contents of a directory on your own machine. Returns file and subdirectory names with type indicators and sizes.";
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
            description: "The directory path to list",
          },
          glob: {
            type: "string",
            description: "Filter entries by glob pattern, e.g. '*.md'",
          },
          activity: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are doing and why, shown to the user as a status update.",
          },
        },
        required: ["path", "activity"],
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

    const ops = new FileSystemOps((path, opts) =>
      sandboxPolicy(path, context.workingDir, opts),
    );

    const result = ops.listDirSafe({
      path: rawPath,
      glob: typeof input.glob === "string" ? input.glob : undefined,
    });

    if (!result.ok) {
      const { error } = result;
      switch (error.code) {
        case "NOT_A_DIRECTORY":
          return {
            content: `Error: ${error.path} is not a directory`,
            isError: true,
          };
        case "NOT_FOUND":
          return {
            content: `Error: directory not found: ${error.path}`,
            isError: true,
          };
        default: {
          const hint =
            error.code === "PATH_OUT_OF_BOUNDS"
              ? ". To list files outside the workspace, use the host_bash tool instead."
              : "";
          return {
            content: `Error: ${error.message}${hint}`,
            isError: true,
          };
        }
      }
    }

    return { content: result.value.listing, isError: false };
  }
}

export const fileListTool = new FileListTool();
registerTool(fileListTool);
