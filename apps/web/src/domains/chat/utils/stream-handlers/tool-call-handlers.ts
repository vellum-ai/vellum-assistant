import {
  applyToolResult,
  upsertToolCall,
} from "@/domains/chat/utils/stream-updaters/tool-call-updaters";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type {
  ToolResultEvent,
  ToolUsePreviewStartEvent,
  ToolUseStartEvent,
} from "@vellumai/assistant-api";

/**
 * Render a pending tool-call block the moment the model starts generating a
 * tool call, before its arguments finish streaming. The block carries the
 * tool name with empty input and reads as "running" (spinner) until the
 * matching `tool_use_start` upgrades it in place with the real input —
 * `upsertToolCall` merges by id, and the daemon emits both events with the
 * same provider tool-use id.
 *
 * Deliberately does not touch the turn store: `onToolUseStart`/`onToolResult`
 * are a balanced pair, and a preview followed by its `tool_use_start` would
 * double-count the call.
 */
export function handleToolUsePreviewStart(
  event: ToolUsePreviewStartEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.cancelReconciliation();
  const newToolCall: ChatMessageToolCall = {
    id: event.toolUseId,
    name: event.toolName,
    input: {},
    isPreview: true,
    startedAt: Date.now(),
  };
  ctx.setMessages((prev) => {
    const next = upsertToolCall(prev, newToolCall, event.messageId);
    const tail = next[next.length - 1];
    if (tail?.role === "assistant") {
      ctx.currentAssistantMessageIdRef.current = tail.id;
    }
    return next;
  });
}

export function handleToolUseStart(
  event: ToolUseStartEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.cancelReconciliation();
  ctx.turnActions.onToolUseStart();
  const toolCallId =
    event.toolUseId ?? `tool-${++ctx.toolCallIdCounterRef.current}`;
  const newToolCall: ChatMessageToolCall = {
    id: toolCallId,
    name: event.toolName,
    input: event.input,
    // Explicit false (not omitted) so the by-id merge in `upsertToolCall`
    // clears the flag when this event upgrades a preview block in place.
    isPreview: false,
    startedAt:
      "startedAt" in event &&
      typeof event.startedAt === "number"
        ? event.startedAt
        : Date.now(),
  };
  ctx.setMessages((prev) => {
    const next = upsertToolCall(prev, newToolCall, event.messageId);
    const tail = next[next.length - 1];
    // Stamp the current-assistant ref to the assistant tail. See parallel
    // logic in handleAssistantTextDelta.
    if (tail?.role === "assistant") {
      ctx.currentAssistantMessageIdRef.current = tail.id;
    }
    return next;
  });
}

export function handleToolResult(
  event: ToolResultEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.onToolResult();
  // Forward structured tool activity metadata (web_search / web_fetch) onto
  // the turn store so the web-search inline link can render during the
  // active turn. Metadata is live-only — the store clears it on idle
  // transitions; historical reopens continue through the existing
  // `result: string` flow below (parsed for fallback chips).
  if (event.activityMetadata && event.toolUseId) {
    ctx.turnActions.onToolActivityMetadata(
      event.toolUseId,
      event.activityMetadata,
    );
  }
  ctx.setMessages((prev) =>
    applyToolResult(prev, {
      toolUseId: event.toolUseId,
      result: event.result,
      isError: event.isError,
      riskLevel: event.riskLevel,
      riskReason: event.riskReason,
      matchedTrustRuleId: event.matchedTrustRuleId,
      approvalMode: event.approvalMode,
      approvalReason: event.approvalReason,
      riskThreshold: event.riskThreshold,
      riskAllowlistOptions: event.riskAllowlistOptions,
      riskScopeOptions: event.riskScopeOptions,
      riskDirectoryScopeOptions: event.riskDirectoryScopeOptions,
      activityMetadata: event.activityMetadata,
      completedAt:
        "completedAt" in event &&
        typeof event.completedAt === "number"
          ? event.completedAt
          : undefined,
    }),
  );
}
