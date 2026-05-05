import { supportsHostProxy } from "../../channels/types.js";
import { HostFileProxy } from "../../daemon/host-file-proxy.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import { FileSystemOps } from "../shared/filesystem/file-ops-service.js";
import { formatEditDiff } from "../shared/filesystem/format-diff.js";
import { hostPolicy } from "../shared/filesystem/path-policy.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

class HostFileEditTool implements Tool {
  name = "host_file_edit";
  description =
    "Replace exact text in a file on your guardian's device with new text. For files on your own machine, use file_edit instead.";
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
            description: "Absolute host path to the file to edit",
          },
          old_string: {
            type: "string",
            description: "The exact text to find in the file",
          },
          new_string: {
            type: "string",
            description: "The replacement text",
          },
          replace_all: {
            type: "boolean",
            description:
              "Replace all occurrences instead of requiring a unique match (default: false)",
          },
          target_client_id: {
            type: "string",
            description:
              "ID of the specific client to execute this on. Required when multiple clients support host_file; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_file`.",
          },
        },
        required: ["path", "old_string", "new_string"],
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

    const oldString = input.old_string;
    if (typeof oldString !== "string") {
      return {
        content: "Error: old_string is required and must be a string",
        isError: true,
      };
    }

    const newString = input.new_string;
    if (typeof newString !== "string") {
      return {
        content: "Error: new_string is required and must be a string",
        isError: true,
      };
    }

    if (oldString.length === 0) {
      return { content: "Error: old_string must not be empty", isError: true };
    }

    if (oldString === newString) {
      return {
        content: "Error: old_string and new_string must be different",
        isError: true,
      };
    }

    const replaceAll = input.replace_all === true;

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
    // when a capable client is available (managed/cloud-hosted mode).
    if (HostFileProxy.instance.isAvailable()) {
      return HostFileProxy.instance.request(
        {
          operation: "edit",
          path: rawPath,
          old_string: oldString as string,
          new_string: newString as string,
          replace_all: replaceAll,
          targetClientId,
        },
        context.conversationId,
        context.signal,
      );
    }

    const ops = new FileSystemOps(hostPolicy);

    const result = ops.editFileSafe({
      path: rawPath,
      oldString,
      newString,
      replaceAll,
    });

    if (!result.ok) {
      const { error } = result;
      switch (error.code) {
        case "MATCH_NOT_FOUND":
          return {
            content: `Error: old_string not found in ${error.path}`,
            isError: true,
          };
        case "MATCH_AMBIGUOUS":
          return {
            content: `Error: old_string appears multiple times in ${error.path}. Provide more surrounding context to make it unique, or set replace_all to true.`,
            isError: true,
          };
        case "IO_ERROR":
          return {
            content: `Error editing file: ${error.message}`,
            isError: true,
          };
        default:
          return { content: `Error: ${error.message}`, isError: true };
      }
    }

    const {
      filePath,
      matchCount,
      oldContent,
      newContent,
      matchMethod,
      similarity,
      actualOld,
      actualNew,
    } = result.value;

    const diffText = formatEditDiff(actualOld, actualNew);

    if (replaceAll) {
      return {
        content: `Successfully replaced ${matchCount} occurrence${
          matchCount > 1 ? "s" : ""
        } in ${filePath}\n${diffText}`,
        isError: false,
        diff: { filePath, oldContent, newContent, isNewFile: false },
      };
    }

    const methodNote =
      matchMethod === "exact"
        ? ""
        : matchMethod === "whitespace"
          ? " (matched with whitespace normalization)"
          : ` (fuzzy matched, ${Math.round(similarity * 100)}% similar)`;

    return {
      content: `Successfully edited ${filePath}${methodNote}\n${diffText}`,
      isError: false,
      diff: { filePath, oldContent, newContent, isNewFile: false },
    };
  }
}

export const hostFileEditTool: Tool = new HostFileEditTool();
