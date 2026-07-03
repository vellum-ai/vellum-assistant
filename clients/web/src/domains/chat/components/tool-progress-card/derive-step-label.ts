/**
 * Pure utility that maps a non-web tool call to a `(title, info, iconName)`
 * tuple used to populate the unified tool-call progress card's carousel
 * header.
 *
 * Web tool calls (`web_search`, `web_fetch`) are handled separately by the
 * unified card-data pipeline's web builders — they don't flow through this
 * function. See `clients/web/src/domains/chat/hooks/use-tool-call-card-data.ts`.
 *
 * This module is intentionally pure: no React, no Zustand, no I/O. Inputs are
 * the tool call payload; outputs are deterministic strings + icon name.
 */

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { titleCaseToolName } from "@/domains/chat/components/tool-call-chip/utils";
import { truncate } from "@/domains/chat/utils/truncate";

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
  | "terminal"
  | "file"
  | "pen"
  | "monitor"
  | "plug"
  | "sparkle"
  | "user-plus"
  | "bolt"
  | "brain"
  | "globe";

/** Result of mapping a tool call to its carousel-header label. */
export interface StepLabel {
  title: string;
  info: string;
  /**
   * Rich, human-readable activity sentence the daemon attaches to the tool
   * input (`input.activity`, legacy `input.reason`), mirroring macOS
   * `reasonDescription`. Empty string when absent. Drives pill/drawer text;
   * `title` remains the stable phase-grouping key — do NOT fold activity into
   * `title`.
   */
  activity: string;
  iconName: IconName;
}

const INFO_MAX_LENGTH = 80;

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
 * Tool input bag understood by `deriveStepLabelFromName`. The full
 * `ChatMessageToolCall` carries additional fields (status, completedAt,
 * etc.) that this helper does not need — accepting just `(toolName, input)`
 * lets non-`ChatMessageToolCall` callers (the subagent inline card, which
 * operates on `SubagentTimelineEvent`) share the same labeling table.
 */
export function deriveStepLabelFromName(
  toolName: string,
  input?: unknown,
): StepLabel {
  const inputBag: Record<string, unknown> =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const name = toolName.toLowerCase();

  // Rich activity sentence the daemon attaches to the input. Computed once and
  // spread onto every branch so phase-grouping (`title`/`info`/`iconName`)
  // stays untouched. `readString` trims and returns "" when neither key is set.
  const activity = readString(inputBag, "activity", "reason");

  const mcp = parseMcpToolName(toolName);
  if (mcp) {
    return {
      title: `Using ${mcp.serverName}`,
      info: mcp.toolMethod,
      activity,
      iconName: "plug",
    };
  }

  switch (name) {
    case "bash":
    case "host_bash": {
      const command = readString(inputBag, "command", "cmd");
      const cleaned = command.replace(/\s+/g, " ").trim();
      return {
        title: "Working",
        info: truncate(cleaned, INFO_MAX_LENGTH),
        activity,
        iconName: "terminal",
      };
    }

    case "str_replace_editor":
    case "text_editor": {
      const sub = readString(inputBag, "command").toLowerCase();
      const file = basename(
        readString(inputBag, "path", "file_path", "filePath"),
      );
      if (sub === "view") {
        return { title: "Reading", info: file, activity, iconName: "file" };
      }
      // create / insert / str_replace (and any other write sub-command) all
      // map to "Editing" so any mutation surfaces as an edit.
      return { title: "Editing", info: file, activity, iconName: "pen" };
    }

    case "computer": {
      const action = readString(inputBag, "action");
      return {
        title: "Using computer",
        info: action,
        activity,
        iconName: "monitor",
      };
    }

    case "skill_execute": {
      // `skill_execute` is the daemon's shim for invoking bundled-skill
      // tools — the real tool name lives in `input.tool` and its arguments
      // in `input.input`. Recurse on the inner tool so the card surfaces a
      // useful label ("Working", "Spawning subagent", …) instead of
      // a generic "Using a skill" with no detail. Falls back to the legacy
      // skill label when the input shape isn't a recognisable wrapper.
      const innerTool = readString(inputBag, "tool");
      if (innerTool) {
        const innerInput = inputBag.input;
        const inner = deriveStepLabelFromName(innerTool, innerInput);
        // The daemon attaches `activity` to the OUTER `skill_execute` input;
        // let it win over any activity on the inner tool's input.
        return { ...inner, activity: activity || inner.activity };
      }
      const skillName = readString(inputBag, "skill", "name", "skillName");
      return {
        title: "Using a skill",
        info: skillName,
        activity,
        iconName: "sparkle",
      };
    }

    case "skill":
    case "skill_invoke":
    case "skill_load": {
      const skillName = readString(inputBag, "skill", "name", "skillName");
      return {
        title: "Using a skill",
        info: skillName,
        activity,
        iconName: "sparkle",
      };
    }

    case "subagent_spawn": {
      const label = readString(inputBag, "label", "objective", "task");
      return {
        title: "Spawning subagent",
        info: label,
        activity,
        iconName: "user-plus",
      };
    }

    default:
      return {
        title: toolName ? `Running ${titleCaseToolName(toolName)}` : "Running tool",
        info: "",
        activity,
        iconName: "bolt",
      };
  }
}

/**
 * Derive the (title, info, iconName) tuple for a non-web tool call.
 *
 * Branches mirror the tool names already understood by the legacy
 * `ToolCallChip` (`clients/web/src/domains/chat/components/tool-call-chip/`) plus
 * the additional Anthropic-native tool names (`str_replace_editor`,
 * `text_editor`, `computer`, MCP-prefixed tools, skills, subagent spawns) that
 * the unified card needs to label.
 */
export function deriveStepLabel(toolCall: ChatMessageToolCall): StepLabel {
  return deriveStepLabelFromName(toolCall.name, toolCall.input);
}
