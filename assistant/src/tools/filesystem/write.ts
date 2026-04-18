import { join, resolve, sep } from "node:path";

import { enqueuePkbIndexJob } from "../../memory/jobs/embed-pkb-file.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { registerTool } from "../registry.js";
import { FileSystemOps } from "../shared/filesystem/file-ops-service.js";
import { formatWriteSummary } from "../shared/filesystem/format-diff.js";
import { sandboxPolicy } from "../shared/filesystem/path-policy.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const logger = getLogger("file-write");

/**
 * Returns `true` iff `absPath` is an absolute path that resolves strictly
 * inside `pkbRoot`. Matches the containment semantics used elsewhere in the
 * daemon (e.g. `pkb-context-tracker`): a root-with-separator prefix check,
 * guarding against `<root>siblingDir` false positives.
 */
function isInsidePkbRoot(absPath: string, pkbRoot: string): boolean {
  const normalizedRoot = resolve(pkbRoot);
  const normalized = resolve(absPath);
  if (normalized === normalizedRoot) return false;
  const rootWithSep = normalizedRoot.endsWith(sep)
    ? normalizedRoot
    : normalizedRoot + sep;
  return normalized.startsWith(rootWithSep);
}

class FileWriteTool implements Tool {
  name = "file_write";
  description =
    "Write content to a file on your own machine, creating it if it does not exist. Use host_file_write for files on your guardian's device instead.";
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

    // If the write landed inside the workspace PKB root, enqueue a
    // fire-and-forget re-index job so Qdrant stays in sync with on-disk
    // content. Failures here must never surface to the caller — a file
    // was written successfully and that is the user-facing contract.
    try {
      const pkbRoot = join(getWorkspaceDir(), "pkb");
      if (isInsidePkbRoot(filePath, pkbRoot)) {
        enqueuePkbIndexJob({
          pkbRoot,
          absPath: filePath,
          memoryScopeId: context.memoryScopeId ?? "default",
        });
      }
    } catch (err) {
      logger.warn(
        {
          filePath,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to enqueue PKB re-index job after file_write",
      );
    }

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
