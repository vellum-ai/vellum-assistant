import { extname } from "node:path";

import { supportsHostProxy } from "../../channels/types.js";
import { HostFileProxy } from "../../daemon/host-file-proxy.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
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
    "Read the contents of a file on your guardian's device, including images (JPEG, PNG, GIF, WebP). For files on your own machine, use file_read instead.";
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
          target_client_id: {
            type: "string",
            description:
              "ID of the specific client to execute this on. Required when multiple clients support host_file; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_file`.",
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

    const targetClientId =
      typeof input.target_client_id === "string" &&
      input.target_client_id !== ""
        ? input.target_client_id
        : undefined;

    const transportInterface = context.transportInterface;
    if (
      targetClientId == null &&
      transportInterface != null &&
      !supportsHostProxy(transportInterface) &&
      assistantEventHub.listClientsByCapability("host_file").length > 1
    ) {
      return {
        content: `Error: multiple clients support host_file. Specify which client to use with \`target_client_id\`. Run \`assistant clients list --capability host_file\` to see client IDs and labels.`,
        isError: true,
      };
    }

    // Guard: non-host-proxy interfaces with no capable clients connected.
    // Without this guard, the request would fall through to local
    // FileSystemOps below and read the daemon container's filesystem
    // instead of the user's host machine.
    if (
      targetClientId == null &&
      transportInterface != null &&
      !supportsHostProxy(transportInterface) &&
      !HostFileProxy.instance.isAvailable()
    ) {
      return {
        content:
          "Error: no client with host_file capability is connected. Connect a macOS client to use host_file from a non-desktop interface.",
        isError: true,
      };
    }

    // Guard: explicit targetClientId provided but proxy is unavailable.
    // Fires on non-host-proxy transports (web, ios) AND on legacy callers
    // without transport metadata, where falling through to local fs would
    // silently target the daemon container's filesystem instead of the
    // intended host client. Skips only when transport is explicitly
    // host-proxy-capable (macos), where local-fs fallback IS the intended
    // offline behavior — a stale target_client_id auto-filled from a prior
    // cross-client turn is silently ignored on those turns.
    // Note: this scoping deliberately differs from host_bash
    // (host-shell.ts:239-247), which rejects unconditionally for any
    // stale target_client_id regardless of transport.
    if (
      targetClientId != null &&
      !HostFileProxy.instance.isAvailable() &&
      (transportInterface == null || !supportsHostProxy(transportInterface))
    ) {
      return {
        content: `Error: target client "${targetClientId}" is no longer connected. The specified client may have disconnected since the tool was called. Run \`assistant clients list --capability host_file\` to see currently connected clients.`,
        isError: true,
      };
    }

    // Proxy to connected client for execution on the user's machine
    // when a capable client is available (managed/cloud-hosted mode),
    // including image reads that need the host filesystem view.
    if (HostFileProxy.instance.isAvailable()) {
      return HostFileProxy.instance.request(
        {
          operation: "read",
          path: rawPath,
          offset: typeof input.offset === "number" ? input.offset : undefined,
          limit: typeof input.limit === "number" ? input.limit : undefined,
          targetClientId,
        },
        context.conversationId,
        context.signal,
        targetClientId,
        context.sourceActorPrincipalId,
      );
    }

    const ext = extname(rawPath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      const pathCheck = hostPolicy(rawPath);
      if (!pathCheck.ok) {
        return { content: `Error: ${pathCheck.error}`, isError: true };
      }
      return readImageFile(pathCheck.resolved);
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
