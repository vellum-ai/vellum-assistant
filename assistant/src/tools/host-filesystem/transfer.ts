import { constants } from "node:fs";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { supportsHostProxy } from "../../channels/types.js";
import { HostTransferProxy } from "../../daemon/host-transfer-proxy.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import { sandboxPolicy } from "../shared/filesystem/path-policy.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

class HostFileTransferTool implements Tool {
  name = "host_file_transfer";
  description =
    "Copy a file between the assistant's workspace and the user's host machine. Set direction to 'to_host' to send a workspace file to the host, or 'to_sandbox' to pull a host file into the workspace. When multiple clients support host_file, specify which one to use with target_client_id.";
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
          target_client_id: {
            type: "string",
            description:
              "ID of the specific client to transfer files to/from. Required when multiple clients support host_file; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_file`.",
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

    const targetClientId =
      typeof input.target_client_id === "string" && input.target_client_id !== ""
        ? input.target_client_id
        : undefined;

    if (
      targetClientId == null &&
      context.transportInterface != null &&
      !supportsHostProxy(context.transportInterface) &&
      assistantEventHub.listClientsByCapability("host_file").length > 1
    ) {
      return { content: `Error: multiple clients support host_file. Specify which client to use with \`target_client_id\`. Run \`assistant clients list --capability host_file\` to see client IDs and labels.`, isError: true };
    }

    // Guard: non-host-proxy interfaces with no capable clients connected.
    // Without this guard, a web/ios turn whose host_file client has
    // disconnected since projection would fall through to executeLocal
    // below and act on the daemon container's filesystem instead of
    // the user's host machine.
    if (
      targetClientId == null &&
      context.transportInterface != null &&
      !supportsHostProxy(context.transportInterface) &&
      !HostTransferProxy.instance.isAvailable()
    ) {
      return {
        content:
          "Error: no client with host_file capability is connected. Connect a macOS client to use host_file from a non-desktop interface.",
        isError: true,
      };
    }

    // Guard: explicit targetClientId provided but proxy is unavailable.
    // Fires on non-host-proxy transports (web, ios) AND on legacy callers
    // without transport metadata, where falling through to executeLocal
    // would silently target the daemon container's filesystem instead of
    // the intended host client. Skips only when transport is explicitly
    // host-proxy-capable (macos), where local-fs fallback IS the intended
    // offline behavior — a stale target_client_id auto-filled from a prior
    // cross-client turn is silently ignored on those turns.
    // Note: this scoping deliberately differs from host_bash
    // (host-shell.ts:239-247), which rejects unconditionally for any
    // stale target_client_id regardless of transport.
    if (
      targetClientId != null &&
      !HostTransferProxy.instance.isAvailable() &&
      (context.transportInterface == null ||
        !supportsHostProxy(context.transportInterface))
    ) {
      return {
        content: `Error: target client "${targetClientId}" is no longer connected. The specified client may have disconnected since the tool was called. Run \`assistant clients list --capability host_file\` to see currently connected clients.`,
        isError: true,
      };
    }

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
            targetClientId,
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
          targetClientId,
        },
        context.signal,
      );
    }

    // Local mode: direct filesystem copy. The non-host-proxy + stale
    // target_client_id case is caught by the scoped guard at the top of
    // execute(); on macos a stale target_client_id is silently ignored
    // here, matching the read/write/edit pattern.
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
