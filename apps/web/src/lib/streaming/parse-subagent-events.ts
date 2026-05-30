/**
 * Legacy parsers for subagent orchestration events.
 *
 * Subagents are daemon-spawned child assistants that run in parallel
 * with the parent conversation. These three events cover spawn,
 * status transitions, and inner event forwarding.
 */

import type { AssistantEvent } from "@/types/event-types";
import type {
  SubagentInnerEvent,
  SubagentStatus,
} from "@/types/interaction-ui-types";
import { unknownEvent } from "@/lib/streaming/parse-helpers";

export function parseSubagentSpawned(
  data: Record<string, unknown>,
): AssistantEvent {
  const subagentId =
    typeof data.subagentId === "string" ? data.subagentId : "";
  const label = typeof data.label === "string" ? data.label : "";
  if (!subagentId || !label) {
    return unknownEvent("subagent_spawned", data);
  }
  return {
    type: "subagent_spawned",
    subagentId,
    parentConversationId:
      typeof data.parentConversationId === "string"
        ? data.parentConversationId
        : undefined,
    label,
    objective: typeof data.objective === "string" ? data.objective : "",
    isFork: typeof data.isFork === "boolean" ? data.isFork : undefined,
    parentToolUseId:
      typeof data.parentToolUseId === "string"
        ? data.parentToolUseId
        : undefined,
    conversationId:
      typeof data.conversationId === "string"
        ? data.conversationId
        : undefined,
  };
}

export function parseSubagentStatusChanged(
  data: Record<string, unknown>,
): AssistantEvent {
  const subagentId =
    typeof data.subagentId === "string" ? data.subagentId : "";
  const status = typeof data.status === "string" ? data.status : "";
  if (!subagentId || !status) {
    return unknownEvent("subagent_status_changed", data);
  }
  const usage =
    data.usage &&
    typeof data.usage === "object" &&
    !Array.isArray(data.usage)
      ? (data.usage as Record<string, unknown>)
      : null;
  return {
    type: "subagent_status_changed",
    subagentId,
    status: status as SubagentStatus,
    error: typeof data.error === "string" ? data.error : undefined,
    inputTokens:
      typeof usage?.inputTokens === "number"
        ? usage.inputTokens
        : undefined,
    outputTokens:
      typeof usage?.outputTokens === "number"
        ? usage.outputTokens
        : undefined,
    totalCost:
      typeof usage?.estimatedCost === "number"
        ? usage.estimatedCost
        : undefined,
    conversationId:
      typeof data.conversationId === "string"
        ? data.conversationId
        : undefined,
  };
}

export function parseSubagentEvent(
  data: Record<string, unknown>,
): AssistantEvent {
  const subagentId =
    typeof data.subagentId === "string" ? data.subagentId : "";
  const event = data.event;
  if (
    !subagentId ||
    !event ||
    typeof event !== "object" ||
    Array.isArray(event)
  ) {
    return unknownEvent("subagent_event", data);
  }
  return {
    type: "subagent_event",
    subagentId,
    conversationId:
      typeof data.conversationId === "string"
        ? data.conversationId
        : undefined,
    event: event as SubagentInnerEvent,
  };
}
