import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type {
  ToolResultEvent,
  ToolUsePreviewStartEvent,
  ToolUseStartEvent,
} from "@vellumai/assistant-api";

/**
 * Optimistic pre-input affordance: the moment the daemon recognizes a tool call
 * (before its input finishes streaming), the rolling-snapshot reducer renders a
 * running tool card so the user sees activity immediately. The handler only
 * stamps the current-assistant anchor for subagent attribution.
 */
export function handleToolUsePreviewStart(
  event: ToolUsePreviewStartEvent,
  ctx: StreamHandlerContext,
): void {
  if (event.messageId) {
    ctx.currentAssistantMessageIdRef.current = event.messageId;
  }
}

export function handleToolUseStart(
  event: ToolUseStartEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.cancelReconciliation();
  ctx.turnActions.onToolUseStart();
  // The reducer folds the tool call onto the assistant row in the snapshot;
  // the handler owns the turn-state transition and the anchor stamp.
  if (event.messageId) {
    ctx.currentAssistantMessageIdRef.current = event.messageId;
  }
}

export function handleToolResult(
  event: ToolResultEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.onToolResult();
  // Forward structured tool activity metadata (web_search / web_fetch) onto
  // the turn store so the web-search inline link can render during the
  // active turn. Metadata is live-only — the store clears it on idle
  // transitions; the durable tool result is folded into the snapshot by the
  // reducer (which also clears any live `streamedOutput` in favor of the
  // complete `result`).
  if (event.activityMetadata && event.toolUseId) {
    ctx.turnActions.onToolActivityMetadata(
      event.toolUseId,
      event.activityMetadata,
    );
  }
}
