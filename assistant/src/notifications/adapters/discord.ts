/**
 * Discord channel adapter: delivers notifications to the guardian's DM by
 * calling the Discord REST API directly.
 *
 * The destination endpoint is the guardian's *user* snowflake, never a stored
 * channel id: user and channel snowflakes are indistinguishable bare numbers,
 * so the adapter resolves the DM channel from the person at send time
 * (cached per user) and a room id on the binding can never become a delivery
 * target. That is Slack's D-prefix DM gate, achieved by construction.
 *
 * Approval notifications carry the typed-command instructions instead of
 * component buttons: nothing ingests INTERACTION_CREATE yet, and a button
 * whose press goes nowhere is a dead control. When interaction ingest lands,
 * buttons arrive here as a rendering upgrade, not a new decision path.
 */

import { openDiscordDmChannel } from "../../messaging/providers/discord/api.js";
import {
  editDiscordMessage,
  sendDiscordReply,
} from "../../messaging/providers/discord/send.js";
import { ConfigError } from "../../util/errors.js";
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
import { appendPlainTextFallback, resolveMessageText } from "./shared.js";

const log = getLogger("notif-adapter-discord");

export class DiscordAdapter implements ChannelAdapter {
  readonly channel: NotificationChannel = "discord";

  async send(
    payload: ChannelDeliveryPayload,
    destination: ChannelDestination,
  ): Promise<DeliveryResult> {
    const guardianUserId = destination.endpoint;
    if (!guardianUserId) {
      log.warn(
        { sourceEventName: payload.sourceEventName },
        "Discord destination has no guardian user id; skipping",
      );
      return {
        success: false,
        error: "No guardian user id configured for Discord destination",
      };
    }

    const text = appendPlainTextFallback(
      resolveMessageText(payload),
      payload.approvalContext,
    );

    try {
      const channelId = await openDiscordDmChannel(guardianUserId);
      const sent = await sendDiscordReply({ channelId }, text);

      log.info(
        { sourceEventName: payload.sourceEventName, guardianUserId },
        "Discord notification delivered",
      );

      // The message id lets the delivery row address the card later
      // (in-place withdrawal when the request resolves elsewhere).
      return { success: true, messageId: sent.lastMessageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A missing bot token means the operator simply hasn't configured
      // Discord; it is not a code fault, so log it at warn to keep it out
      // of Sentry. Genuine and transient failures stay at error so they
      // remain visible.
      const logFn = err instanceof ConfigError ? log.warn : log.error;
      logFn(
        { err, sourceEventName: payload.sourceEventName, guardianUserId },
        "Failed to deliver Discord notification",
      );
      return { success: false, error: message };
    }
  }

  /**
   * Replace a delivered notification in place, so a card that has been
   * answered or withdrawn stops reading as still waiting.
   */
  async update(
    delivery: ChannelUpdateContext,
    patch: ChannelUpdatePayload,
  ): Promise<DeliveryResult> {
    if (!delivery.messageId) {
      return {
        success: false,
        error:
          "missing_message_id: this delivery has no captured Discord message id",
      };
    }
    const text = patch.body?.trim() || patch.title?.trim();
    if (!text) {
      return { success: false, error: "no body or title supplied for update" };
    }
    try {
      // The delivery row's destination is the guardian's user snowflake, so
      // the edit resolves the same cached DM channel the send used.
      const channelId = await openDiscordDmChannel(delivery.destination);
      await editDiscordMessage({ channelId }, delivery.messageId, text);
      log.info(
        { guardianUserId: delivery.destination, messageId: delivery.messageId },
        "Discord notification updated",
      );
      // An edit keeps the message it addressed, so the delivery row's id
      // still identifies the card.
      return { success: true, messageId: delivery.messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          guardianUserId: delivery.destination,
          messageId: delivery.messageId,
        },
        "Failed to update Discord notification",
      );
      return { success: false, error: message };
    }
  }
}
