import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { minimatch } from "minimatch";

import { RiskLevel } from "../../permissions/types.js";
import { registerTool } from "../registry.js";
import { sandboxPolicy } from "../shared/filesystem/path-policy.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

// Directory names that are never worth searching and would otherwise dominate
// the file budget (dependencies, VCS metadata).
const IGNORED_DIRS = new Set(["node_modules", ".git"]);

// Defensive caps so a search over a huge tree cannot read the whole disk into
// memory. These bound the walk regardless of `max_results`.
const MAX_FILES_SCANNED = 20_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 256 MiB
const MAX_FILE_BYTES = 8 * 1024 * 1024; // skip files larger than 8 MiB

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_CONTEXT_LINES = 0;

/** Heuristic binary-file detection: a NUL byte in the leading bytes. */
function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export const codeSearchTool = {
  name: "code_search",
  description:
    "Search file contents for a regular-expression pattern across a directory tree on your own machine, returning matching `path:line: text` lines. Read-only — never modifies files. Skips node_modules, .git, and binary files. Use this to grep across files without a shell.",
  category: "filesystem",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,

  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular-expression pattern to search for in file contents",
      },
      path: {
        type: "string",
        description:
          "Directory to search under (defaults to the working directory)",
      },
      glob: {
        type: "string",
        description:
          "Only search files whose path (relative to the search root) matches this glob, e.g. '*.ts' or 'src/**'",
      },
      case_insensitive: {
        type: "boolean",
        description: "Match the pattern case-insensitively",
      },
      context_lines: {
        type: "number",
        description:
          "Number of lines of context to include before and after each match (default 0)",
      },
      max_results: {
        type: "number",
        description: "Maximum number of matches to return (default 200)",
      },
      activity: {
        type: "string",
        description:
          "Brief non-technical explanation of what you are doing and why, shown as a status update.",
      },
    },
    required: ["pattern", "activity"],
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const pattern = input.pattern;
    if (!pattern || typeof pattern !== "string") {
      return {
        content: "Error: pattern is required and must be a non-empty string",
        isError: true,
      };
    }

    const rawPath =
      typeof input.path === "string" && input.path.length > 0
        ? input.path
        : context.workingDir;

    const pathCheck = sandboxPolicy(rawPath, context.workingDir);
    if (!pathCheck.ok) {
      return {
        content: `Error: ${pathCheck.error}. To search outside the workspace, use the host_bash tool instead.`,
        isError: true,
      };
    }
    const root = pathCheck.resolved;

    const caseInsensitive = input.case_insensitive === true;
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseInsensitive ? "i" : "");
    } catch (err) {
      return {
        content: `Error: invalid pattern "${pattern}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        isError: true,
      };
    }

    const glob =
      typeof input.glob === "string" && input.glob.length > 0
        ? input.glob
        : undefined;

    const contextLines =
      typeof input.context_lines === "number" && input.context_lines > 0
        ? Math.floor(input.context_lines)
        : DEFAULT_CONTEXT_LINES;

    const maxResults =
      typeof input.max_results === "number" && input.max_results > 0
        ? Math.floor(input.max_results)
        : DEFAULT_MAX_RESULTS;

    const lines: string[] = [];
    let matchCount = 0;
    let truncated = false;
    let filesScanned = 0;
    let totalBytes = 0;

    const walk = (dir: string): void => {
      if (truncated) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (truncated) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;

        const rel = relative(root, full);
        // matchBase lets a slash-free pattern like "*.ts" match files at any
        // depth (against the basename); patterns with slashes match the full
        // relative path. dot so dotfiles aren't silently excluded.
        if (glob && !minimatch(rel, glob, { matchBase: true, dot: true })) {
          continue;
        }

        if (filesScanned >= MAX_FILES_SCANNED) {
          truncated = true;
          return;
        }

        let size: number;
        try {
          size = statSync(full).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_BYTES) continue;
        if (totalBytes + size > MAX_TOTAL_BYTES) {
          truncated = true;
          return;
        }

        let buf: Buffer;
        try {
          buf = readFileSync(full);
        } catch {
          continue;
        }
        filesScanned++;
        totalBytes += buf.length;
        if (looksBinary(buf)) continue;

        const fileLines = buf.toString("utf8").split("\n");
        for (let i = 0; i < fileLines.length; i++) {
          if (!regex.test(fileLines[i])) continue;
          if (matchCount >= maxResults) {
            truncated = true;
            return;
          }
          const lineNo = i + 1;
          if (contextLines > 0) {
            const start = Math.max(0, i - contextLines);
            const end = Math.min(fileLines.length - 1, i + contextLines);
            for (let j = start; j <= end; j++) {
              const sep = j === i ? ":" : "-";
              lines.push(`${rel}:${j + 1}${sep} ${fileLines[j]}`);
            }
            lines.push("--");
          } else {
            lines.push(`${rel}:${lineNo}: ${fileLines[i]}`);
          }
          matchCount++;
        }
      }
    };

    walk(root);

    if (matchCount === 0) {
      return {
        content: `No matches found for /${pattern}/${caseInsensitive ? "i" : ""} under ${basename(root)}`,
        isError: false,
      };
    }

    let content = lines.join("\n");
    if (truncated) {
      content += `\n\n[Results truncated at ${maxResults} matches. Narrow your pattern, glob, or path to see more.]`;
    }

    return {
      content,
      isError: false,
      ...(truncated ? { status: "truncated" } : {}),
    };
  },
} satisfies ToolDefinition;

registerTool(codeSearchTool);
