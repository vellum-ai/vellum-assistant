import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator.js";
import { saveContextWindowUsage } from "@/domains/chat/utils/contextWindowStorage.js";
import {
  extractConversationKey,
  postLocalNotification,
  sendNotificationIntentAck,
} from "@/runtime/notifications.js";
import { useConversationListStore } from "@/domains/conversations/conversation-list-store.js";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types.js";
import type { AvatarUpdatedEvent, CompactionCircuitClosedEvent, CompactionCircuitOpenEvent, ConversationListInvalidatedEvent, ConversationTitleUpdatedEvent, DiskPressureStatusChangedEvent, IdentityChangedEvent, NotificationIntentEvent, UsageUpdateEvent } from "@/domains/chat/api/event-types.js";

export function handleUsageUpdate(
  event: UsageUpdateEvent,
  ctx: StreamHandlerContext,
): void {
  const tokens = event.contextWindowTokens;
  const maxTokens = event.contextWindowMaxTokens;
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return;

  const resolvedMax =
    typeof maxTokens === "number" &&
    Number.isFinite(maxTokens) &&
    maxTokens > 0
      ? maxTokens
      : null;
  const fillRatio =
    resolvedMax != null
      ? Math.min(1, Math.max(0, tokens / resolvedMax))
      : null;
  const usage: ContextWindowUsage = {
    tokens,
    maxTokens: resolvedMax,
    fillRatio,
  };
  const streamCtx = ctx.streamContextRef.current;
  if (streamCtx) {
    ctx.contextWindowUsageByConversationRef.current.set(
      streamCtx.conversationKey,
      usage,
    );
    saveContextWindowUsage(
      streamCtx.assistantId,
      streamCtx.conversationKey,
      usage,
    );
  }
  ctx.setContextWindowUsage(usage);
}

export function handleConversationListInvalidated(
  _event: ConversationListInvalidatedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.scheduleConversationListRefetch();
}

export function handleConversationTitleUpdated(
  event: ConversationTitleUpdatedEvent,
  _ctx: StreamHandlerContext,
): void {
  useConversationListStore.getState().patchConversation(event.conversationId, { title: event.title });
}

export function handleNotificationIntent(
  event: NotificationIntentEvent,
  ctx: StreamHandlerContext,
): void {
  const streamCtx = ctx.streamContextRef.current;
  const ackAssistantId = streamCtx?.assistantId;

  if (event.targetGuardianPrincipalId) {
    if (ackAssistantId && event.deliveryId) {
      void sendNotificationIntentAck(
        ackAssistantId,
        event.deliveryId,
        true,
      );
    }
    return;
  }

  const metadataConversationKey = extractConversationKey(
    event.deepLinkMetadata,
  );
  if (
    metadataConversationKey &&
    metadataConversationKey === ctx.activeConversationKeyRef.current
  ) {
    if (ackAssistantId && event.deliveryId) {
      void sendNotificationIntentAck(
        ackAssistantId,
        event.deliveryId,
        true,
      );
    }
    return;
  }

  void postLocalNotification({
    title: event.title,
    body: event.body,
    sourceEventName: event.sourceEventName,
    deliveryId: event.deliveryId,
    deepLinkMetadata: event.deepLinkMetadata,
    assistantId: ackAssistantId,
  });
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

export function handleDiskPressureStatusChanged(
  event: DiskPressureStatusChangedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.applyDiskPressureStatusEvent(event.status);
}

export function handleIdentityChanged(
  _event: IdentityChangedEvent,
  ctx: StreamHandlerContext,
): void {
  void ctx.refreshAssistantIdentity(true);
}

export function handleAvatarUpdated(
  _event: AvatarUpdatedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.invalidateAvatar();
}
