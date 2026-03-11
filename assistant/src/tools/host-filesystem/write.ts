import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { FileSystemOps } from "../shared/filesystem/file-ops-service.js";
import { formatWriteSummary } from "../shared/filesystem/format-diff.js";
import { hostPolicy } from "../shared/filesystem/path-policy.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

class HostFileWriteTool implements Tool {
  name = "host_file_write";
  description =
    "Write content to a file on the host filesystem, creating it if it does not exist";
  category = "host-filesystem";
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute host path to the file to write",
          },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of why this file is being written, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
        required: ["path", "content", "reason"],
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

    // Proxy to connected client for execution on the user's machine
    // when a capable client is available (managed/cloud-hosted mode).
    if (context.hostFileProxy?.isAvailable()) {
      return context.hostFileProxy.request(
        {
          operation: "write",
          path: rawPath,
          content: fileContent,
        },
        context.sessionId,
        context.signal,
      );
    }

    const ops = new FileSystemOps(hostPolicy);

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

export const hostFileWriteTool: Tool = new HostFileWriteTool();
