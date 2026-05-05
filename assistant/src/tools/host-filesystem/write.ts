import { supportsHostProxy } from "../../channels/types.js";
import { HostFileProxy } from "../../daemon/host-file-proxy.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import { FileSystemOps } from "../shared/filesystem/file-ops-service.js";
import { formatWriteSummary } from "../shared/filesystem/format-diff.js";
import { hostPolicy } from "../shared/filesystem/path-policy.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

class HostFileWriteTool implements Tool {
  name = "host_file_write";
  description =
    "Write content to a file on your guardian's device, creating it if it does not exist. For files on your own machine, use file_write instead.";
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
          target_client_id: {
            type: "string",
            description:
              "ID of the specific client to execute this on. Required when multiple clients support host_file; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_file`.",
          },
        },
        required: ["path", "content"],
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

    const targetClientId =
      typeof input.target_client_id === "string" && input.target_client_id !== ""
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

    // Guard: explicit targetClientId provided on a non-host-proxy transport
    // but proxy is unavailable (client disconnected between tool-definition
    // and tool-execution). Scoped to !supportsHostProxy so macos turns —
    // where local-fs fallback IS the intended offline behavior — still fall
    // through if the LLM auto-fills a stale target_client_id from a prior
    // cross-client turn. On web/ios, the call must fail loudly rather
    // than silently target the daemon container's filesystem.
    // Note: this scoping deliberately differs from host_bash
    // (host-shell.ts:239-247), which rejects unconditionally for any
    // stale target_client_id regardless of transport.
    if (
      targetClientId != null &&
      transportInterface != null &&
      !supportsHostProxy(transportInterface) &&
      !HostFileProxy.instance.isAvailable()
    ) {
      return {
        content: `Error: target client "${targetClientId}" is no longer connected. The specified client may have disconnected since the tool was called. Run \`assistant clients list --capability host_file\` to see currently connected clients.`,
        isError: true,
      };
    }

    // Proxy to connected client for execution on the user's machine
    // when a capable client is available (managed/cloud-hosted mode).
    if (HostFileProxy.instance.isAvailable()) {
      return HostFileProxy.instance.request(
        {
          operation: "write",
          path: rawPath,
          content: fileContent,
          targetClientId,
        },
        context.conversationId,
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
