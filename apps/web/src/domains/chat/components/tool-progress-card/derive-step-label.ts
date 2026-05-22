/**
 * Pure utility that maps a non-web tool call to a `(title, info, iconName)`
 * tuple used to populate the unified tool-call progress card's carousel
 * header.
 *
 * Web tool calls (`web_search`, `web_fetch`) are handled separately by the
 * unified card-data pipeline's web builders — they don't flow through this
 * function. See `apps/web/src/domains/chat/hooks/use-tool-call-card-data.ts`.
 *
 * This module is intentionally pure: no React, no Zustand, no I/O. Inputs are
 * the tool call payload; outputs are deterministic strings + icon name.
 */

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types.js";

/**
 * Canonical icon names used by the unified tool-call progress card.
 *
 * Each value corresponds to a lucide-react icon the renderer maps to in the
 * carousel header. Defined here so this module stays the single source of
 * truth for icon identifiers; downstream PRs (card shell, hook) reuse this
 * union.
 */
export type IconName =
  | "code"
  | "file"
  | "pen"
  | "monitor"
  | "plug"
  | "sparkle"
  | "user-plus"
  | "bolt";

/** Result of mapping a tool call to its carousel-header label. */
export interface StepLabel {
  title: string;
  info: string;
  iconName: IconName;
}

const INFO_MAX_LENGTH = 80;

/** Truncate a string to `max` chars, appending an ellipsis when truncated. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}

/** Read a string property from a tool input bag, returning `""` when absent. */
function readString(
  input: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return "";
}

/** Extract the trailing path segment from a file path. Returns `""` if empty. */
function basename(path: string): string {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx === -1) return trimmed;
  return trimmed.slice(idx + 1);
}

/**
 * Title-case a snake_case / kebab-case tool name for the fallback label.
 * Kept local so this module has zero deps on the legacy `tool-call-chip` code,
 * which PRs 5+ will retire. Exported for reuse by adjacent consumers (e.g. the
 * subagent inline card) that need the same "Tool Name" → "Tool Name" mapping
 * but operate on a different tool-call shape than `ChatMessageToolCall`.
 */
export function humanizeToolName(toolName: string): string {
  return toolName
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Parse an `mcp__<server>__<method>` tool name into its server/method parts.
 * MCP tool names follow the pattern produced by `toProviderSafeToolName` in
 * `assistant/src/tools/mcp/mcp-tool-factory.ts`. Returns `null` when the
 * pattern doesn't match.
 */
function parseMcpToolName(
  toolName: string,
): { serverName: string; toolMethod: string } | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep === -1) return null;
  const serverName = rest.slice(0, sep);
  const toolMethod = rest.slice(sep + 2);
  if (!serverName || !toolMethod) return null;
  return { serverName, toolMethod };
}

/**
 * Derive the (title, info, iconName) tuple for a non-web tool call.
 *
 * Branches mirror the tool names already understood by the legacy
 * `ToolCallChip` (`apps/web/src/domains/chat/components/tool-call-chip/`) plus
 * the additional Anthropic-native tool names (`str_replace_editor`,
 * `text_editor`, `computer`, MCP-prefixed tools, skills, subagent spawns) that
 * the unified card needs to label.
 */
export function deriveStepLabel(toolCall: ChatMessageToolCall): StepLabel {
  const { toolName, input } = toolCall;
  const name = toolName.toLowerCase();

  const mcp = parseMcpToolName(toolName);
  if (mcp) {
    return {
      title: `Using ${mcp.serverName}`,
      info: mcp.toolMethod,
      iconName: "plug",
    };
  }

  switch (name) {
    case "bash":
    case "host_bash": {
      const command = readString(input, "command", "cmd");
      const cleaned = command.replace(/\s+/g, " ").trim();
      return {
        title: "Working (bash)",
        info: truncate(cleaned, INFO_MAX_LENGTH),
        iconName: "code",
      };
    }

    case "str_replace_editor":
    case "text_editor": {
      const sub = readString(input, "command").toLowerCase();
      const file = basename(readString(input, "path", "file_path", "filePath"));
      if (sub === "view") {
        return { title: "Reading", info: file, iconName: "file" };
      }
      // create / insert / str_replace (and any other write sub-command) all
      // map to "Editing" so any mutation surfaces as an edit.
      return { title: "Editing", info: file, iconName: "pen" };
    }

    case "computer": {
      const action = readString(input, "action");
      return {
        title: "Using computer",
        info: action,
        iconName: "monitor",
      };
    }

    case "skill":
    case "skill_execute":
    case "skill_invoke":
    case "skill_load": {
      const skillName = readString(input, "skill", "name", "skillName");
      return {
        title: "Using a skill",
        info: skillName,
        iconName: "sparkle",
      };
    }

    case "subagent_spawn": {
      const label = readString(input, "label", "objective", "task");
      return {
        title: "Spawning subagent",
        info: label,
        iconName: "user-plus",
      };
    }

    default:
      return {
        title: `Running ${humanizeToolName(toolName)}`,
        info: "",
        iconName: "bolt",
      };
  }
}
