/**
 * Vellum channel adapter — delivers notifications to connected desktop
 * and mobile clients via the daemon's event broadcast mechanism.
 *
 * The adapter broadcasts a `notification_intent` message that the client
 * turns into an OS notification (`use-notification-intent-sync.ts` in the
 * web client, which every first-party app runs). The `silent` flag is true
 * for non-urgent (`low`/`medium`) signals, and the client posts nothing for
 * those: they reach their conversation (and the home feed, for background
 * work) without a banner.
 * Urgent signals (`high`/`critical`) broadcast with `silent: false` and
 * banner.
 *
 * Guardian-sensitive notifications (approval requests, access requests)
 * are delivered only to connections authenticated as the guardian: the hub
 * matches `targetActorPrincipalId` against each connection's verified
 * principal, so no other connection ever receives the title and body. The
 * payload's `targetGuardianPrincipalId` records that scoping for clients.
 */

import type { AssistantEvent } from "../../api/index.js";
import { getAssistantName } from "../../daemon/identity-helpers.js";
import { updateMessageContent } from "../../persistence/conversation-crud.js";
import type { BroadcastMessageOptions } from "../../runtime/assistant-event-hub.js";
import { publishConversationMessagesChanged } from "../../runtime/sync/resource-sync-events.js";
import { getLogger } from "../../util/logger.js";
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
  ChannelUpdateContext,
  ChannelUpdatePayload,
  DeliveryResult,
  NotificationChannel,
} from "../types.js";

const log = getLogger("notif-adapter-vellum");

export type BroadcastFn = (
  msg: AssistantEvent,
  conversationId?: string,
  options?: BroadcastMessageOptions,
) => void;

/**
 * Event name prefixes that carry guardian-sensitive content (approval
 * requests, access requests). Notifications for these events reach only
 * the guardian's own connections.
 */
const GUARDIAN_SENSITIVE_EVENT_PREFIXES = [
  "guardian.question",
  "ingress.access_request",
  "guardian.channel_activation",
] as const;

export function isGuardianSensitiveEvent(sourceEventName: string): boolean {
  return GUARDIAN_SENSITIVE_EVENT_PREFIXES.some(
    (prefix) =>
      sourceEventName === prefix || sourceEventName.startsWith(prefix + "."),
  );
}

export class VellumAdapter implements ChannelAdapter {
  readonly channel: NotificationChannel = "vellum";

  private broadcast: BroadcastFn;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
  }

  async send(
    payload: ChannelDeliveryPayload,
    destination: ChannelDestination,
  ): Promise<DeliveryResult> {
    try {
      // For guardian-sensitive events, deliver only to the guardian's own
      // connections. The guardianPrincipalId comes from the vellum binding
      // resolved by the destination resolver.
      const guardianPrincipalId =
        typeof destination.metadata?.guardianPrincipalId === "string"
          ? destination.metadata.guardianPrincipalId
          : undefined;

      const targetGuardianPrincipalId =
        guardianPrincipalId && isGuardianSensitiveEvent(payload.sourceEventName)
          ? guardianPrincipalId
          : undefined;

      const silent =
        payload.urgency !== "high" && payload.urgency !== "critical";
      const assistantName = getAssistantName()?.trim() || undefined;

      this.broadcast(
        {
          type: "notification_intent",
          deliveryId: payload.deliveryId,
          correlationId: payload.correlationId,
          sourceEventName: payload.sourceEventName,
          ...(assistantName ? { assistantName } : {}),
          title: payload.copy.title,
          body: payload.copy.body,
          deepLinkMetadata: payload.deepLinkTarget,
          targetGuardianPrincipalId,
          silent,
          remotePushDispatched: payload.remotePushDispatched,
          remotePushPlatforms: payload.remotePushPlatforms,
        },
        undefined,
        { targetActorPrincipalId: targetGuardianPrincipalId },
      );

      log.info(
        {
          sourceEventName: payload.sourceEventName,
          title: payload.copy.title,
          guardianScoped: targetGuardianPrincipalId != null,
          silent,
        },
        "Vellum notification intent broadcast",
      );

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, sourceEventName: payload.sourceEventName },
        "Failed to broadcast Vellum notification intent",
      );
      return { success: false, error: message };
    }
  }

  /**
   * Rewrite the conversation message this delivery persisted.
   *
   * A vellum delivery has no channel-native message to patch, but it does
   * carry the id of the row written into the conversation the notification
   * card links to. Editing a notification patches the feed item, so without
   * this the card would show the new body while "Go to Conversation" opened
   * the old one.
   *
   * That row holds the body, and the feed rewrites its summary only when the
   * patch carries one, so a title-only patch leaves the row alone to keep the
   * two in step. A delivery carrying no message id has no row to rewrite.
   */
  async update(
    delivery: ChannelUpdateContext,
    patch: ChannelUpdatePayload,
  ): Promise<DeliveryResult> {
    if (!delivery.messageId) {
      return {
        success: false,
        error:
          "missing_message_id: this delivery persisted no conversation message",
      };
    }
    if (patch.body === undefined) {
      log.info(
        { deliveryId: delivery.deliveryId, messageId: delivery.messageId },
        "Vellum notification edit carried no body, conversation message left as is",
      );
      return { success: true, messageId: delivery.messageId };
    }
    try {
      updateMessageContent(delivery.messageId, patch.body);
      if (delivery.conversationId) {
        publishConversationMessagesChanged(delivery.conversationId);
      }
      log.info(
        { deliveryId: delivery.deliveryId, messageId: delivery.messageId },
        "Vellum notification conversation message updated",
      );
      return { success: true, messageId: delivery.messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, deliveryId: delivery.deliveryId, messageId: delivery.messageId },
        "Failed to update Vellum notification conversation message",
      );
      return { success: false, error: message };
    }
  }
}
