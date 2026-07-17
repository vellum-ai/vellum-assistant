/**
 * Vellum channel adapter — delivers notifications to connected desktop
 * and mobile clients via the daemon's event broadcast mechanism.
 *
 * The adapter broadcasts a `notification_intent` message that the Vellum
 * client uses for two distinct purposes: paired-conversation bookkeeping
 * (mark-unseen + history catch-up, fallback dedup) and posting an OS
 * banner via `UNUserNotificationCenter`. The banner posting is gated by
 * the `silent` flag — set to true for non-urgent (`low`/`medium`) signals
 * so the notification center inbox still receives the entry but the OS
 * does not surface a push banner. Urgent signals (`high`/`critical`)
 * broadcast with `silent: false` and fire the banner.
 *
 * Guardian-sensitive notifications (approval requests, access requests)
 * are annotated with `targetGuardianPrincipalId` so that only clients
 * bound to the guardian identity display them. Non-guardian clients
 * should ignore notifications with a `targetGuardianPrincipalId` that
 * does not match their own identity.
 */

import type { InterfaceId } from "../../channels/types.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import { getLogger } from "../../util/logger.js";
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
  DeliveryResult,
  NotificationChannel,
} from "../types.js";

const log = getLogger("notif-adapter-vellum");

/**
 * Optional targeting/filtering applied at the hub when a broadcast is
 * emitted. Mirrors the third argument of
 * `broadcastMessage()` in `runtime/assistant-event-hub.ts`. Callers can
 * use `targetInterfaceId` to scope a legacy message to a single client
 * surface (e.g. macOS) during a migration window.
 */
export interface BroadcastFnOptions {
  targetClientId?: string;
  targetInterfaceId?: InterfaceId;
}

export type BroadcastFn = (
  msg: ServerMessage,
  conversationId?: string,
  options?: BroadcastFnOptions,
) => void;

/**
 * Event name prefixes that carry guardian-sensitive content (approval
 * requests, access requests). Notifications for these events are scoped
 * to bound guardian devices via `targetGuardianPrincipalId`.
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
      // For guardian-sensitive events, annotate the outbound message with
      // the target guardian identity so clients can filter. The
      // guardianPrincipalId comes from the vellum binding resolved by
      // the destination resolver.
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

      this.broadcast({
        type: "notification_intent",
        deliveryId: payload.deliveryId,
        sourceEventName: payload.sourceEventName,
        title: payload.copy.title,
        body: payload.copy.body,
        deepLinkMetadata: payload.deepLinkTarget,
        targetGuardianPrincipalId,
        silent,
      } as ServerMessage);

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
}
