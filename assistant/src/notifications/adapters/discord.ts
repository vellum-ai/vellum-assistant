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
 * Approval notifications render component buttons whose presses the gateway
 * ingests as button events on the shared `apr:` callback convention; a
 * rendering failure falls back to the plain-text card with typed-command
 * instructions, so a card is always actionable one way or the other.
 */

import { openDiscordDmChannel } from "../../messaging/providers/discord/api.js";
import {
  DiscordPartialSendError,
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

    const messageText = resolveMessageText(payload);
    const approval = payload.approvalContext;

    try {
      const channelId = await openDiscordDmChannel(guardianUserId);

      if (approval) {
        // Attempt rich delivery with component buttons; on failure, fall
        // back to the plain-text card below.
        try {
          const sent = await sendDiscordReply(
            { channelId },
            messageText,
            approval,
          );
          log.info(
            { sourceEventName: payload.sourceEventName, guardianUserId },
            "Discord approval notification delivered with buttons",
          );
          // The message id lets the delivery row address the card later
          // (reactions, button presses, in-place withdrawal).
          return { success: true, messageId: sent.lastMessageId };
        } catch (richErr) {
          if (richErr instanceof DiscordPartialSendError) {
            // The leading chunks are delivered and cannot be unsent, so a
            // full plain-text fallback would duplicate them. Complete the
            // card instead: the undelivered remainder plus the typed-command
            // instructions, whose message becomes the card's address.
            log.warn(
              {
                err: richErr,
                sourceEventName: payload.sourceEventName,
                guardianUserId,
                chunksSent: richErr.chunksSent,
              },
              "Rich Discord delivery failed mid-card, completing in plain text",
            );
            const completion = await sendDiscordReply(
              { channelId },
              appendPlainTextFallback(richErr.remainingText, approval),
            );
            return { success: true, messageId: completion.lastMessageId };
          }
          log.warn(
            {
              err: richErr,
              sourceEventName: payload.sourceEventName,
              guardianUserId,
            },
            "Rich Discord delivery failed, falling back to plain text",
          );
        }
      }

      // When falling back from rich delivery, append the plain-text
      // instructions so the guardian still knows how to approve/reject.
      const sent = await sendDiscordReply(
        { channelId },
        appendPlainTextFallback(messageText, approval),
      );

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
