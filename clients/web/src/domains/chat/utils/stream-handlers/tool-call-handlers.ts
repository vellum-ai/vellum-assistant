import {
  MAX_STREAMED_OUTPUT_CHARS,
  appendToolOutputChunk,
  applyToolResult,
  upsertToolCall,
} from "@/domains/chat/utils/stream-updaters/tool-call-updaters";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { useStreamStore } from "@/domains/chat/stream-store";
import type {
  ToolOutputChunkEvent,
  ToolResultEvent,
  ToolUseStartEvent,
} from "@vellumai/assistant-api";

/** Buffer key for chunks that arrive without a `toolUseId` (pre-anchor daemons). */
const NO_TOOL_ID = "no-tool-id";

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
  // Commit any buffered live output before the final result lands so the tail
  // isn't lost and ordering is preserved (applyToolResult then clears
  // `streamedOutput` in favor of the complete `result`).
  flushToolOutput(ctx);
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
      imageData: event.imageData,
      imageDataList: event.imageDataList,
      activityMetadata: event.activityMetadata,
      completedAt:
        "completedAt" in event &&
        typeof event.completedAt === "number"
          ? event.completedAt
          : undefined,
    }),
  );
}

/**
 * Drain all buffered tool-output chunks into a single `setMessages` update,
 * cancelling any pending scheduled flush. Called on the rAF tick and
 * synchronously by `handleToolResult` (so a buffered tail commits before the
 * final result). A no-op when the buffer is empty.
 */
export function flushToolOutput(ctx: StreamHandlerContext): void {
  const handle = ctx.toolOutputFlushHandleRef.current;
  if (handle != null) {
    cancelAnimationFrame(handle);
    ctx.toolOutputFlushHandleRef.current = null;
  }
  const buffer = ctx.toolOutputBufferRef.current;
  if (buffer.size === 0) return;
  const pending = [...buffer.entries()];
  buffer.clear();
  // A deferred flush (rAF) can fire after the user switched conversations (or
  // while a background tab's rAF was paused). Drop buffered chunks whose
  // conversation is no longer the active stream conversation, so a prior
  // conversation's output is never grafted onto — or misattributed within (the
  // id-less fallback path) — the now-active conversation's transcript.
  const activeConversationId =
    useStreamStore.getState().streamContext?.conversationId;
  ctx.setMessages((prev) => {
    let next = prev;
    for (const [toolUseId, { conversationId, messageId, text }] of pending) {
      if (conversationId && conversationId !== activeConversationId) continue;
      next = appendToolOutputChunk(next, {
        chunk: text,
        toolUseId: toolUseId === NO_TOOL_ID ? undefined : toolUseId,
        messageId,
      });
    }
    return next;
  });
}

/**
 * Buffer an incremental `tool_output_chunk` and schedule a coalesced flush.
 *
 * Foreground bash stdout/stderr can arrive at high frequency; batching one
 * flush per animation frame keeps the (non-virtualized) transcript projection
 * from re-running per chunk. Chunks accumulate per `toolUseId`, and the
 * buffered text is itself bounded so a backgrounded tab (rAF paused) can't grow
 * it without limit — only the tail matters for the drawer preview.
 */
export function handleToolOutputChunk(
  event: ToolOutputChunkEvent,
  ctx: StreamHandlerContext,
): void {
  if (!event.chunk) return;
  const key = event.toolUseId ?? NO_TOOL_ID;
  const buffer = ctx.toolOutputBufferRef.current;
  const existing = buffer.get(key);
  if (existing) {
    const combined = existing.text + event.chunk;
    existing.text =
      combined.length > MAX_STREAMED_OUTPUT_CHARS
        ? combined.slice(combined.length - MAX_STREAMED_OUTPUT_CHARS)
        : combined;
    // Prefer the latest non-empty row/conversation anchor.
    if (event.messageId) existing.messageId = event.messageId;
    if (event.conversationId) existing.conversationId = event.conversationId;
  } else {
    buffer.set(key, {
      conversationId: event.conversationId,
      messageId: event.messageId,
      text: event.chunk,
    });
  }
  if (ctx.toolOutputFlushHandleRef.current == null) {
    ctx.toolOutputFlushHandleRef.current = requestAnimationFrame(() => {
      ctx.toolOutputFlushHandleRef.current = null;
      flushToolOutput(ctx);
    });
  }
}
