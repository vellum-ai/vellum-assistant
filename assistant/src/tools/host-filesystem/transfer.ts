import { constants } from "node:fs";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { HostTransferProxy } from "../../daemon/host-transfer-proxy.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { sandboxPolicy } from "../shared/filesystem/path-policy.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

class HostFileTransferTool implements Tool {
  name = "host_file_transfer";
  description =
    "Copy a file between the assistant's workspace and the user's host machine. Set direction to 'to_host' to send a workspace file to the host, or 'to_sandbox' to pull a host file into the workspace.";
  category = "host-filesystem";
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          source_path: {
            type: "string",
            description:
              "Source file path. For to_host, a workspace path — relative paths resolve against the sandbox working directory; /workspace/... paths are also accepted. For to_sandbox, must be an absolute host path.",
          },
          dest_path: {
            type: "string",
            description:
              "Destination path. For to_host, must be an absolute host path. For to_sandbox, a workspace path — relative paths resolve against the sandbox working directory; /workspace/... paths are also accepted.",
          },
          direction: {
            type: "string",
            enum: ["to_host", "to_sandbox"],
            description:
              "Transfer direction: 'to_host' sends a workspace file to the host, 'to_sandbox' pulls a host file into the workspace.",
          },
          overwrite: {
            type: "boolean",
            description:
              "Whether to overwrite the destination file if it already exists (default: false)",
          },
          activity: {
            type: "string",
            description:
              "Brief description of why the file is being transferred (for audit logging)",
          },
        },
        required: ["source_path", "dest_path", "direction"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const sourcePath = input.source_path;
    if (!sourcePath || typeof sourcePath !== "string") {
      return {
        content: "Error: source_path is required and must be a string",
        isError: true,
      };
    }

    const destPath = input.dest_path;
    if (!destPath || typeof destPath !== "string") {
      return {
        content: "Error: dest_path is required and must be a string",
        isError: true,
      };
    }

    const direction = input.direction;
    if (direction !== "to_host" && direction !== "to_sandbox") {
      return {
        content:
          "Error: direction is required and must be 'to_host' or 'to_sandbox'",
        isError: true,
      };
    }

    const overwrite = input.overwrite === true;

    // Validate that host-side paths are absolute.
    if (direction === "to_host" && !isAbsolute(destPath)) {
      return {
        content: `Error: dest_path must be absolute for host file access: ${destPath}`,
        isError: true,
      };
    }
    if (direction === "to_sandbox" && !isAbsolute(sourcePath)) {
      return {
        content: `Error: source_path must be absolute for host file access: ${sourcePath}`,
        isError: true,
      };
    }

    // Normalize sandbox-side paths — resolves relative paths, remaps /workspace/...,
    // rejects out-of-bounds (same model as file_read / file_write).
    let resolvedSourcePath = sourcePath;
    if (direction === "to_host") {
      const pathCheck = sandboxPolicy(sourcePath, context.workingDir);
      if (!pathCheck.ok) {
        return {
          content: `Invalid source path: ${pathCheck.error}`,
          isError: true,
        };
      }
      resolvedSourcePath = pathCheck.resolved;
    }

    let resolvedDestPath = destPath;
    if (direction === "to_sandbox") {
      const pathCheck = sandboxPolicy(destPath, context.workingDir, { mustExist: false });
      if (!pathCheck.ok) {
        return {
          content: `Invalid destination path: ${pathCheck.error}`,
          isError: true,
        };
      }
      resolvedDestPath = pathCheck.resolved;
    }

    // Managed mode: delegate to the host transfer proxy when available.
    if (HostTransferProxy.instance.isAvailable()) {
      if (direction === "to_host") {
        return HostTransferProxy.instance.requestToHost(
          {
            sourcePath: resolvedSourcePath,
            destPath,
            overwrite,
            conversationId: context.conversationId,
          },
          context.signal,
        );
      }
      return HostTransferProxy.instance.requestToSandbox(
        {
          sourcePath,
          destPath: resolvedDestPath,
          overwrite,
          conversationId: context.conversationId,
        },
        context.signal,
      );
    }

    // Local mode: direct filesystem copy.
    return this.executeLocal(resolvedSourcePath, resolvedDestPath, overwrite);
  }

  private async executeLocal(
    sourcePath: string,
    destPath: string,
    overwrite: boolean,
  ): Promise<ToolExecutionResult> {
    // Resolve symlinks on the source to ensure we read the real file.
    let resolvedSource: string;
    try {
      resolvedSource = await realpath(sourcePath);
    } catch {
      return {
        content: `Error: source file not found: ${sourcePath}`,
        isError: true,
      };
    }

    // Verify the source is a regular file (not a directory).
    try {
      const stat = await lstat(resolvedSource);
      if (stat.isDirectory()) {
        return {
          content: `Error: source path is a directory, not a file: ${sourcePath}. To transfer a directory, archive it first (e.g. tar or zip) and transfer the archive.`,
          isError: true,
        };
      }
      if (!stat.isFile()) {
        return {
          content: `Error: source path is not a regular file: ${sourcePath}`,
          isError: true,
        };
      }
    } catch (err) {
      return {
        content: `Error: cannot stat source file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    // Ensure the destination parent directory exists.
    try {
      await mkdir(dirname(destPath), { recursive: true });
    } catch (err) {
      return {
        content: `Error: failed to create destination directory: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    // COPYFILE_EXCL makes the call fail atomically if dest exists,
    // avoiding a TOCTOU race vs. a separate lstat check.
    try {
      const flags = overwrite ? 0 : constants.COPYFILE_EXCL;
      await copyFile(resolvedSource, destPath, flags);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!overwrite && msg.includes("EEXIST")) {
        return {
          content: `Error: destination file already exists: ${destPath}. Set overwrite to true to replace it.`,
          isError: true,
        };
      }
      const hint = msg.includes("EACCES")
        ? " (permission denied)"
        : msg.includes("ENOSPC")
          ? " (no space left on device)"
          : "";
      return {
        content: `Error copying file${hint}: ${msg}`,
        isError: true,
      };
    }

    return {
      content: `Successfully copied ${sourcePath} to ${destPath}`,
      isError: false,
    };
  }
}

export const hostFileTransferTool: Tool = new HostFileTransferTool();
