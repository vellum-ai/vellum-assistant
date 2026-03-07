/**
 * Vellum channel adapter — delivers notifications to connected desktop
 * and mobile clients via the daemon's IPC broadcast mechanism.
 *
 * The adapter broadcasts a `notification_intent` message that the Vellum
 * client can use to display a native notification (e.g. NSUserNotification
 * or UNUserNotificationCenter).
 *
 * Guardian-sensitive notifications (approval requests, escalation alerts)
 * are annotated with `targetGuardianPrincipalId` so that only clients
 * bound to the guardian identity display them. Non-guardian clients
 * should ignore notifications with a `targetGuardianPrincipalId` that
 * does not match their own identity.
 */

import type { ServerMessage } from "../../daemon/ipc-protocol.js";
import { getLogger } from "../../util/logger.js";
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
  DeliveryResult,
  NotificationChannel,
} from "../types.js";

const log = getLogger("notif-adapter-vellum");

export type BroadcastFn = (msg: ServerMessage) => void;

/**
 * Event name prefixes that carry guardian-sensitive content (approval
 * requests, escalation alerts, access requests). Notifications for
 * these events are scoped to bound guardian devices via
 * `targetGuardianPrincipalId`.
 */
const GUARDIAN_SENSITIVE_EVENT_PREFIXES = [
  "guardian.question",
  "ingress.escalation",
  "ingress.access_request",
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

      this.broadcast({
        type: "notification_intent",
        deliveryId: payload.deliveryId,
        sourceEventName: payload.sourceEventName,
        title: payload.copy.title,
        body: payload.copy.body,
        deepLinkMetadata: payload.deepLinkTarget,
        targetGuardianPrincipalId,
      } as ServerMessage);

      log.info(
        {
          sourceEventName: payload.sourceEventName,
          title: payload.copy.title,
          guardianScoped: targetGuardianPrincipalId != null,
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
