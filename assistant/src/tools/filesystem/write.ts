import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { registerTool } from "../registry.js";
import { FileSystemOps } from "../shared/filesystem/file-ops-service.js";
import { formatWriteSummary } from "../shared/filesystem/format-diff.js";
import { sandboxPolicy } from "../shared/filesystem/path-policy.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

class FileWriteTool implements Tool {
  name = "file_write";
  description = "Write content to a file, creating it if it does not exist";
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
              "The path to the file to write (absolute or relative to working directory)",
          },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
          activity: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are doing and why, shown to the user as a status update.",
          },
        },
        required: ["path", "content", "activity"],
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

    const fileContent = input.content;
    if (typeof fileContent !== "string") {
      return {
        content: "Error: content is required and must be a string",
        isError: true,
      };
    }

    const ops = new FileSystemOps((path, opts) =>
      sandboxPolicy(path, context.workingDir, opts),
    );

    const result = ops.writeFileSafe({ path: rawPath, content: fileContent });

    if (!result.ok) {
      const { error } = result;
      if (error.code === "IO_ERROR") {
        const msg = error.message;
        const hint = msg.includes("ENOENT")
          ? " (parent directory does not exist)"
          : msg.includes("EACCES")
            ? " (permission denied)"
            : msg.includes("EROFS")
              ? " (read-only file system)"
              : "";
        return {
          content: `Error writing file "${rawPath}"${hint}: ${msg}`,
          isError: true,
        };
      }
      return { content: `Error: ${error.message}`, isError: true };
    }

    const { filePath, oldContent, newContent, isNewFile } = result.value;
    return {
      content: `Successfully wrote to ${filePath} ${formatWriteSummary(
        oldContent,
        newContent,
        isNewFile,
      )}`,
      isError: false,
      diff: { filePath, oldContent, newContent, isNewFile },
    };
  }
}

export const fileWriteTool = new FileWriteTool();
registerTool(fileWriteTool);
