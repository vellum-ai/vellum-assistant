import { extname } from "node:path";

import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { FileSystemOps } from "../shared/filesystem/file-ops-service.js";
import {
  IMAGE_EXTENSIONS,
  readImageFile,
} from "../shared/filesystem/image-read.js";
import { hostPolicy } from "../shared/filesystem/path-policy.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

class HostFileReadTool implements Tool {
  name = "host_file_read";
  description =
    "Read the contents of a file on the host filesystem, including images (JPEG, PNG, GIF, WebP). Not for workspace files under .vellum (use file_read instead).";
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
            description: "Absolute path to the host file to read",
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

    // Image files must be handled locally — the host-file proxy protocol
    // only carries {content, isError} and cannot transport contentBlocks
    // (base64 image data). Check for image extensions before the proxy
    // short-circuit so image reads work in managed/macOS+iOS sessions.
    const ext = extname(rawPath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      const pathCheck = hostPolicy(rawPath);
      if (!pathCheck.ok) {
        return { content: `Error: ${pathCheck.error}`, isError: true };
      }
      return readImageFile(pathCheck.resolved);
    }

    // Proxy to connected client for execution on the user's machine
    // when a capable client is available (managed/cloud-hosted mode).
    if (context.hostFileProxy?.isAvailable()) {
      return context.hostFileProxy.request(
        {
          operation: "read",
          path: rawPath,
          offset: typeof input.offset === "number" ? input.offset : undefined,
          limit: typeof input.limit === "number" ? input.limit : undefined,
        },
        context.conversationId,
        context.signal,
      );
    }

    const ops = new FileSystemOps(hostPolicy);

    const result = ops.readFileSafe({
      path: rawPath,
      offset: typeof input.offset === "number" ? input.offset : undefined,
      limit: typeof input.limit === "number" ? input.limit : undefined,
    });

    if (!result.ok) {
      const { error } = result;
      switch (error.code) {
        case "NOT_FOUND":
          return {
            content: `Error: File not found: ${error.path}`,
            isError: true,
          };
        case "NOT_A_FILE":
          return {
            content: `Error: ${error.path} is not a regular file`,
            isError: true,
          };
        case "IO_ERROR": {
          const msg = error.message;
          const hint = msg.includes("ENOENT")
            ? " (file does not exist)"
            : msg.includes("EACCES")
              ? " (permission denied)"
              : msg.includes("EISDIR")
                ? " (path is a directory, not a file)"
                : "";
          return {
            content: `Error reading file "${rawPath}"${hint}: ${msg}`,
            isError: true,
          };
        }
        default:
          return { content: `Error: ${error.message}`, isError: true };
      }
    }

    return { content: result.value.content, isError: false };
  }
}

export const hostFileReadTool: Tool = new HostFileReadTool();
