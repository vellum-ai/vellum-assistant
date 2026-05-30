/**
 * Legacy parsers for tool execution lifecycle events.
 *
 * Covers the three phases of a daemon-side tool call: start
 * (with input), progress ticks, and the final result (with risk
 * metadata for trust-rule evaluation).
 */

import type { AssistantEvent } from "@/types/event-types";
import type {
  AllowlistOption,
  DirectoryScopeOption,
} from "@/types/interaction-ui-types";
import type { ToolActivityMetadata } from "@/assistant/web-activity-types";

export function parseToolUseStart(
  data: Record<string, unknown>,
): AssistantEvent {
  return {
    type: "tool_use_start",
    toolName: typeof data.toolName === "string" ? data.toolName : "unknown",
    input:
      typeof data.input === "object" && data.input !== null
        ? (data.input as Record<string, unknown>)
        : {},
    toolUseId:
      typeof data.toolUseId === "string" ? data.toolUseId : undefined,
    messageId:
      typeof data.messageId === "string" ? data.messageId : undefined,
    conversationId:
      typeof data.conversationId === "string"
        ? data.conversationId
        : undefined,
  };
}

export function parseToolResult(
  data: Record<string, unknown>,
): AssistantEvent {
  return {
    type: "tool_result",
    toolName: typeof data.toolName === "string" ? data.toolName : "unknown",
    result: typeof data.result === "string" ? data.result : "",
    isError: typeof data.isError === "boolean" ? data.isError : undefined,
    toolUseId:
      typeof data.toolUseId === "string" ? data.toolUseId : undefined,
    messageId:
      typeof data.messageId === "string" ? data.messageId : undefined,
    conversationId:
      typeof data.conversationId === "string"
        ? data.conversationId
        : undefined,
    riskLevel:
      typeof data.riskLevel === "string" ? data.riskLevel : undefined,
    riskReason:
      typeof data.riskReason === "string" ? data.riskReason : undefined,
    matchedTrustRuleId:
      typeof data.matchedTrustRuleId === "string"
        ? data.matchedTrustRuleId
        : undefined,
    approvalMode:
      typeof data.approvalMode === "string" ? data.approvalMode : undefined,
    approvalReason:
      typeof data.approvalReason === "string"
        ? data.approvalReason
        : undefined,
    riskThreshold:
      typeof data.riskThreshold === "string"
        ? data.riskThreshold
        : undefined,
    // The daemon emits two semantically distinct arrays on tool_result:
    //   - `riskAllowlistOptions`  → Minimatch-glob save-path patterns (the
    //     ones that get persisted as a trust rule's `pattern`). This is
    //     what the rule editor's "Apply to" radio group needs.
    //   - `riskScopeOptions`      → display-only ladder, can carry
    //     regex-flavored descriptors that are NOT valid trust rule
    //     patterns. We deliberately do not feed these into the save path.
    allowlistOptions: Array.isArray(data.riskAllowlistOptions)
      ? (data.riskAllowlistOptions as AllowlistOption[])
      : undefined,
    directoryScopeOptions: Array.isArray(data.riskDirectoryScopeOptions)
      ? (data.riskDirectoryScopeOptions as DirectoryScopeOption[])
      : undefined,
    // Daemon emits `activityMetadata` on tool_result for tools that report
    // structured activity (currently Anthropic-native web_search). Treated
    // as opaque on the wire — the downstream consumer (turn-state) keys
    // off the discriminated child fields (webSearch/webFetch).
    activityMetadata:
      typeof data.activityMetadata === "object" &&
      data.activityMetadata !== null &&
      !Array.isArray(data.activityMetadata)
        ? (data.activityMetadata as ToolActivityMetadata)
        : undefined,
  };
}
