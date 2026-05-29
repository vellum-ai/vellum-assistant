import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator";
import { saveContextWindowUsage } from "@/domains/chat/utils/context-window-storage";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type {
  CompactionCircuitClosedEvent,
  CompactionCircuitOpenEvent,
} from "@vellumai/assistant-api";
import type {
  TurnProfileAutoRoutedEvent,
  UsageUpdateEvent,
} from "@/types/event-types";

export function handleUsageUpdate(
  event: UsageUpdateEvent,
  ctx: StreamHandlerContext,
): void {
  const tokens = event.contextWindowTokens;
  const maxTokens = event.contextWindowMaxTokens;
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return;

  const resolvedMax =
    typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
      ? maxTokens
      : null;
  const fillRatio =
    resolvedMax != null ? Math.min(1, Math.max(0, tokens / resolvedMax)) : null;
  const usage: ContextWindowUsage = {
    tokens,
    maxTokens: resolvedMax,
    fillRatio,
  };
  const streamCtx = ctx.streamContextRef.current;
  if (streamCtx) {
    ctx.contextWindowUsageByConversationRef.current.set(
      streamCtx.conversationId,
      usage,
    );
    saveContextWindowUsage(
      streamCtx.assistantId,
      streamCtx.conversationId,
      usage,
    );
  }
  ctx.setContextWindowUsage(usage);
}

export function handleCompactionCircuitOpen(
  event: CompactionCircuitOpenEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.setCompactionCircuitOpenUntil(new Date(event.openUntil));
}

export function handleCompactionCircuitClosed(
  _event: CompactionCircuitClosedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.setCompactionCircuitOpenUntil(null);
}

export function handleTurnProfileAutoRouted(
  event: TurnProfileAutoRoutedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.onProfileAutoRouted(event.profileLabel);
}
