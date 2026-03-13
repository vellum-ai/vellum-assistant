import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { FileSystemOps } from "../shared/filesystem/file-ops-service.js";
import { formatEditDiff } from "../shared/filesystem/format-diff.js";
import { hostPolicy } from "../shared/filesystem/path-policy.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

class HostFileEditTool implements Tool {
  name = "host_file_edit";
  description = "Replace exact text in a host filesystem file with new text";
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

    // Proxy to connected client for execution on the user's machine
    // when a capable client is available (managed/cloud-hosted mode).
    if (context.hostFileProxy?.isAvailable()) {
      return context.hostFileProxy.request(
        {
          operation: "edit",
          path: rawPath,
          old_string: oldString as string,
          new_string: newString as string,
          replace_all: replaceAll,
        },
        context.sessionId,
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
