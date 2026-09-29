// The quiet-turn projection of an assistant row (`quiet-turn-activity`
// client flag): which content groups a turn shows, and the one "where it is
// working" line that stands in for the rest while it runs. Pure, no React, so
// the render body and its tests read the same answers.

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { parseMcpToolName } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import {
  activityItemsToCardData,
  type ContentBlockGroup,
} from "@/domains/chat/transcript/message-content";
import { isSendUserMessageCall } from "@/domains/chat/utils/assistant-text-visibility";
import { isUiSurfaceToolCall } from "@/domains/chat/utils/silent-tool-calls";
import {
  COMMAND_KEYS,
  FILE_PATH_KEYS,
  readToolInputString,
} from "@/domains/chat/utils/tool-input";

/** A place named by its own proper noun (a connected service, an MCP server). */
export interface NamedQuietPlace {
  kind: "named";
  name: string;
}

/** A place the client names through its catalog. */
export interface CatalogQuietPlace {
  kind: "files" | "terminal" | "memory" | "web" | "mac";
}

export type QuietPlace = NamedQuietPlace | CatalogQuietPlace;

/**
 * What a tool call does where it works, read from the tool itself: a tool
 * that only reads is `checking`, one that only writes is `updating`, and one
 * that can do either (a shell, an MCP method, computer use) is `using`.
 */
export type QuietVerb = "checking" | "updating" | "using";

/** What the progress line says about one tool call. */
export interface QuietStep {
  verb: QuietVerb;
  place: QuietPlace;
}

/** Tools that talk to the assistant itself rather than work somewhere. */
const UNNAMED_TOOL_NAMES = new Set([
  "notify_parent",
  "subagent_message",
  "skill_load",
  "followup_create",
  "followup_resolve",
]);

const MEMORY_TOOL_NAMES = new Set(["remember", "recall", "delete_memory_page"]);
const WEB_TOOL_NAMES = new Set(["web_search", "web_fetch"]);
const READ_ONLY_TOOL_NAMES = new Set([
  "recall",
  "web_search",
  "web_fetch",
  "file_read",
  "file_list",
  "host_file_read",
]);
const WRITE_TOOL_NAMES = new Set([
  "remember",
  "delete_memory_page",
  "file_write",
  "file_edit",
  "host_file_write",
  "host_file_edit",
]);

/** Service ids whose display name is not simply the capitalized first word. */
const SERVICE_DISPLAY_NAMES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gmail: "Gmail",
  hubspot: "HubSpot",
  linkedin: "LinkedIn",
  openai: "OpenAI",
  quickbooks: "QuickBooks",
  youtube: "YouTube",
};

/** Display name for a service id such as `slack_channel` or `google-calendar`. */
export function serviceDisplayName(serviceId: string): string | null {
  const first = serviceId
    .trim()
    .toLowerCase()
    .split(/[_\-\s.]+/)[0];
  if (!first) {
    return null;
  }
  return (
    SERVICE_DISPLAY_NAMES[first] ?? first[0]!.toUpperCase() + first.slice(1)
  );
}

const REVEAL_RE = /\bcredentials\s+reveal\b/;
const SERVICE_FLAG_RE = /--service(?:=|\s+)["']?([A-Za-z0-9_.-]+)/;

/**
 * The service a shell command reaches through a stored credential, read from
 * its `credentials reveal --service <id>` invocation. A command that talks to
 * a service with the assistant's own credential (curl against the Slack API,
 * say) otherwise reads as plain terminal work.
 */
export function credentialServiceOf(command: string): string | null {
  if (!REVEAL_RE.test(command)) {
    return null;
  }
  const match = SERVICE_FLAG_RE.exec(command);
  return match?.[1] ? serviceDisplayName(match[1]) : null;
}

function isMemoryPath(path: string): boolean {
  return /(^|\/)memory\//.test(path);
}

function placeOf(toolCall: ChatMessageToolCall): QuietPlace | null {
  const name = toolCall.name;
  const input = toolCall.input ?? {};
  if (MEMORY_TOOL_NAMES.has(name)) {
    return { kind: "memory" };
  }
  if (WEB_TOOL_NAMES.has(name)) {
    return { kind: "web" };
  }
  if (name === "bash" || name === "host_bash") {
    const service = credentialServiceOf(
      readToolInputString(input, ...COMMAND_KEYS),
    );
    if (service) {
      return { kind: "named", name: service };
    }
    return name === "host_bash" ? { kind: "mac" } : { kind: "terminal" };
  }
  if (name.startsWith("file_") || name.startsWith("host_file_")) {
    if (isMemoryPath(readToolInputString(input, ...FILE_PATH_KEYS))) {
      return { kind: "memory" };
    }
    return name.startsWith("host_") ? { kind: "mac" } : { kind: "files" };
  }
  if (name === "computer" || name.startsWith("computer_use")) {
    return { kind: "mac" };
  }
  const mcp = parseMcpToolName(name);
  if (mcp) {
    const display = serviceDisplayName(mcp.serverName);
    return display ? { kind: "named", name: display } : null;
  }
  return null;
}

/**
 * What the progress line says while `toolCall` runs, or `null` for a call
 * that works nowhere a user would name (the reply tool, a surface, a skill
 * body load, notes the assistant files for itself).
 */
export function describeQuietStep(
  toolCall: ChatMessageToolCall,
): QuietStep | null {
  if (
    isSendUserMessageCall(toolCall) ||
    isUiSurfaceToolCall(toolCall) ||
    UNNAMED_TOOL_NAMES.has(toolCall.name)
  ) {
    return null;
  }
  const place = placeOf(toolCall);
  if (!place) {
    return null;
  }
  const verb: QuietVerb = READ_ONLY_TOOL_NAMES.has(toolCall.name)
    ? "checking"
    : WRITE_TOOL_NAMES.has(toolCall.name)
      ? "updating"
      : "using";
  return { verb, place };
}

/**
 * The line for the turn's latest nameable tool call: calls run in order, so
 * the newest one that names a place is where the assistant is working now.
 */
export function currentQuietStep(
  toolCalls: readonly ChatMessageToolCall[],
): QuietStep | null {
  for (let index = toolCalls.length - 1; index >= 0; index--) {
    const step = describeQuietStep(toolCalls[index]!);
    if (step) {
      return step;
    }
  }
  return null;
}

/** Index of the first activity group that carries a tool call, or -1. */
export function firstToolGroupIndex(
  groups: readonly ContentBlockGroup[],
): number {
  return groups.findIndex(
    (group) =>
      group.type === "activity" &&
      activityItemsToCardData(group.items).toolCalls.length > 0,
  );
}

/**
 * Every tool call across a row's activity groups, in order. The progress line
 * and the whole-turn steps panel read the turn as one run.
 */
export function turnToolCalls(
  groups: readonly ContentBlockGroup[],
): ChatMessageToolCall[] {
  return groups.flatMap((group) =>
    group.type === "activity"
      ? activityItemsToCardData(group.items).toolCalls
      : [],
  );
}

export interface QuietTurnVisibilityInput {
  groups: readonly ContentBlockGroup[];
  /** Where the turn's answer begins (`finalResponseStartIndex`). */
  finalResponseIndex: number;
  /** Whether the row is the live, still-streaming turn. */
  live: boolean;
  /**
   * Whether a group must stay in view whatever the projection says: a pending
   * confirmation, an inline process card, a surface. The caller owns this
   * because it depends on stores the pure projection does not read.
   */
  isPinned: (group: ContentBlockGroup, index: number) => boolean;
}

/**
 * Which groups a quiet turn hides. Everything before the first tool call is
 * the turn's opening (its acknowledgement, or the whole reply of a turn that
 * never used a tool) and stays, as do surfaces and pinned groups. After it,
 * activity is always hidden: its steps live in the turn's steps panel. Text is
 * hidden while the turn is live, because nothing written there is known to be
 * the answer until the turn ends; once settled, text from
 * `finalResponseIndex` on is the answer and shows.
 */
export function quietTurnHiddenGroups({
  groups,
  finalResponseIndex,
  live,
  isPinned,
}: QuietTurnVisibilityInput): Set<number> {
  const hidden = new Set<number>();
  const firstTool = firstToolGroupIndex(groups);
  if (firstTool === -1) {
    return hidden;
  }
  groups.forEach((group, index) => {
    if (
      index < firstTool ||
      group.type === "surface" ||
      isPinned(group, index)
    ) {
      return;
    }
    if (
      group.type === "text" &&
      !live &&
      finalResponseIndex !== -1 &&
      index >= finalResponseIndex
    ) {
      return;
    }
    hidden.add(index);
  });
  return hidden;
}

/**
 * Whether a live row shows the quiet-turn progress line: it has made a tool
 * call the transcript would draw. The standalone thinking row reads this to
 * stand down, so the two indicators never show at once.
 */
export function hasQuietTurnProgress(message: {
  toolCalls?: { name: string; pendingConfirmation?: unknown }[];
}): boolean {
  return !!message.toolCalls?.some(
    (toolCall) =>
      !isSendUserMessageCall(toolCall) && !isUiSurfaceToolCall(toolCall),
  );
}
