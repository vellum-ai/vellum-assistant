import { newStableId } from "@/domains/chat/utils/stable-id.js";
import {
  applyToolProgress,
  applyToolResult,
  upsertToolCall,
} from "@/domains/chat/hooks/stream-message-updaters.js";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types.js";
import type {
  ChatMessageToolCall,
  ToolProgressEvent,
  ToolResultEvent,
  ToolUseStartEvent,
} from "@/domains/chat/api/event-types.js";

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
    toolName: event.toolName,
    input: event.input,
    status: "running",
    startedAt: Date.now(),
  };
  const shouldCreateNewBubble = ctx.needsNewBubbleRef.current;
  ctx.needsNewBubbleRef.current = false;
  let stableId: string | undefined;
  if (shouldCreateNewBubble) {
    stableId = newStableId("assistant-tool");
    ctx.currentAssistantStableIdRef.current = stableId;
  }
  ctx.setMessages((prev) =>
    upsertToolCall(prev, newToolCall, shouldCreateNewBubble, stableId),
  );
}

export function handleToolProgress(
  event: ToolProgressEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.setMessages((prev) =>
    applyToolProgress(prev, {
      toolUseId: event.toolUseId,
      elapsedSec: event.elapsedSec,
      timeoutSec: event.timeoutSec,
    }),
  );
}

export function handleToolResult(
  event: ToolResultEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.onToolResult();
  // Forward structured tool activity metadata (web_search / web_fetch) onto
  // the turn store so the new WebSearchProgressCard can render during the
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
      allowlistOptions: event.allowlistOptions,
      scopeOptions: event.scopeOptions,
      directoryScopeOptions: event.directoryScopeOptions,
      activityMetadata: event.activityMetadata,
    }),
  );
}
