/**
 * Slack channel adapter — delivers notifications to Slack DMs
 * by calling the Slack Web API directly.
 */

import { sendSlackReply } from "../../messaging/providers/slack/send.js";
import { getLogger } from "../../util/logger.js";
import {
  buildAccessRequestIdentityLine,
  buildAccessRequestInviteDirective,
  buildAccessRequestWarnings,
  buildSlackMessagePermalink,
  isSlackDmConversation,
  parseAccessRequestPayload,
  sanitizeIdentityField,
} from "../access-request-copy.js";
import { isConversationSeedSane } from "../conversation-seed-composer.js";
import { nonEmpty } from "../copy-composer.js";
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
  ChannelUpdateContext,
  ChannelUpdatePayload,
  DeliveryResult,
  NotificationChannel,
} from "../types.js";

const log = getLogger("notif-adapter-slack");

function resolveSlackMessageText(payload: ChannelDeliveryPayload): string {
  const deliveryText = nonEmpty(payload.copy.deliveryText);
  if (deliveryText) return deliveryText;

  if (isConversationSeedSane(payload.copy.conversationSeedMessage)) {
    return payload.copy.conversationSeedMessage.trim();
  }

  const body = nonEmpty(payload.copy.body);
  if (body) return body;

  const title = nonEmpty(payload.copy.title);
  if (title) return title;

  return payload.sourceEventName.replace(/[._]/g, " ");
}

// ---------------------------------------------------------------------------
// Block Kit helpers for access request notifications
// ---------------------------------------------------------------------------

/**
 * Build Block Kit blocks for an access request notification.
 *
 * Returns an array of Slack Block Kit block objects with structured layout:
 * - Header: "New access request"
 * - Section: requester identity details
 * - Optional context: message preview
 * - Context: approval code instructions + invite directive
 */
function buildAccessRequestBlocks(payload: Record<string, unknown>): unknown[] {
  const p = parseAccessRequestPayload(payload);
  const blocks: unknown[] = [];

  // Header
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "New access request", emoji: true },
  });

  // Requester identity section
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: buildAccessRequestIdentityLine(payload) },
  });

  // Structured requester details
  const fields: Array<{ type: "mrkdwn"; text: string }> = [];

  const safeName = nonEmpty(
    p.senderIdentifier ? sanitizeIdentityField(p.senderIdentifier) : undefined,
  );
  if (safeName) {
    fields.push({ type: "mrkdwn", text: `*Name:*\n${safeName}` });
  }

  const safeUsername = nonEmpty(
    p.actorUsername ? sanitizeIdentityField(p.actorUsername) : undefined,
  );
  if (safeUsername) {
    fields.push({ type: "mrkdwn", text: `*Username:*\n@${safeUsername}` });
  }

  if (p.sourceChannel) {
    let channelDisplay = p.sourceChannel;
    if (p.sourceChannel === "slack" && p.conversationExternalId) {
      const permalink = p.messageTs
        ? buildSlackMessagePermalink(p.conversationExternalId, p.messageTs)
        : undefined;

      // C = public/private channels, G = group DMs / MPIMs / legacy private channels.
      // Both support the <#ID> mrkdwn deep-link. D = 1:1 DMs (no linkable channel).
      if (!isSlackDmConversation(p.conversationExternalId)) {
        channelDisplay = permalink
          ? `Slack — <#${p.conversationExternalId}> · <${permalink}|View message>`
          : `Slack — <#${p.conversationExternalId}>`;
      } else {
        channelDisplay = permalink
          ? `Slack — Direct message · <${permalink}|View message>`
          : "Slack — Direct message";
      }
    }
    fields.push({ type: "mrkdwn", text: `*Source:*\n${channelDisplay}` });
  }

  const safeExternalId = nonEmpty(
    p.actorExternalId ? sanitizeIdentityField(p.actorExternalId) : undefined,
  );
  if (safeExternalId && safeExternalId !== safeName) {
    fields.push({ type: "mrkdwn", text: `*ID:*\n${safeExternalId}` });
  }

  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }

  // Unified warnings: revoked + trust signals
  const warnings = buildAccessRequestWarnings(p);
  if (warnings.length > 0) {
    blocks.push({
      type: "context",
      elements: warnings.map((w) => ({
        type: "mrkdwn" as const,
        text: `:warning: ${w}`,
      })),
    });
  }

  // Divider before actions
  blocks.push({ type: "divider" });

  // Approval buttons — same `apr:<requestId>:<action>` callback convention
  // used by gateway's block-kit-builder and Telegram's inline keyboard.
  if (p.requestId) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve", emoji: true },
          action_id: `apr:${p.requestId}:approve_once`,
          value: `apr:${p.requestId}:approve_once`,
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject", emoji: true },
          action_id: `apr:${p.requestId}:reject`,
          value: `apr:${p.requestId}:reject`,
          style: "danger",
        },
      ],
    });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "You can also react with :thumbsup: to approve or :thumbsdown: to deny",
        },
      ],
    });
  }

  // Invite directive
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: buildAccessRequestInviteDirective() }],
  });

  // Guardian verification note
  if (
    (p.guardianResolutionSource === "vellum-anchor" ||
      p.guardianResolutionSource === "none") &&
    p.sourceChannel
  ) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_You haven't verified your identity on ${p.sourceChannel} yet. If this was you trying to message your assistant, say "help me verify as guardian on ${p.sourceChannel}" to set up direct access._`,
        },
      ],
    });
  }

  return blocks;
}

export class SlackAdapter implements ChannelAdapter {
  readonly channel: NotificationChannel = "slack";

  async send(
    payload: ChannelDeliveryPayload,
    destination: ChannelDestination,
  ): Promise<DeliveryResult> {
    const chatId = destination.endpoint;
    if (!chatId) {
      log.warn(
        { sourceEventName: payload.sourceEventName },
        "Slack destination has no chat ID — skipping",
      );
      return {
        success: false,
        error: "No chat ID configured for Slack destination",
      };
    }

    const messageText = resolveSlackMessageText(payload);

    // Build Block Kit blocks for access request notifications
    const isAccessRequest =
      payload.sourceEventName === "ingress.access_request" &&
      payload.contextPayload != null;

    try {
      const result = isAccessRequest
        ? await sendSlackReply(chatId, messageText, {
            blocks: buildAccessRequestBlocks(payload.contextPayload!),
          })
        : await sendSlackReply(chatId, messageText, { useBlocks: true });

      log.info(
        { sourceEventName: payload.sourceEventName, chatId, ts: result.ts },
        "Slack notification delivered",
      );

      return { success: true, messageId: result.ts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, sourceEventName: payload.sourceEventName, chatId },
        "Failed to deliver Slack notification",
      );
      return { success: false, error: message };
    }
  }

  async update(
    delivery: ChannelUpdateContext,
    patch: ChannelUpdatePayload,
  ): Promise<DeliveryResult> {
    if (!delivery.messageId) {
      return {
        success: false,
        error:
          "missing_message_id: this delivery has no captured Slack ts (sent before edit support landed)",
      };
    }
    const text = patch.body?.trim() || patch.title?.trim();
    if (!text) {
      return { success: false, error: "no body or title supplied for update" };
    }
    try {
      const result = await sendSlackReply(delivery.destination, text, {
        messageTs: delivery.messageId,
        useBlocks: true,
      });
      log.info(
        { chatId: delivery.destination, messageTs: delivery.messageId },
        "Slack notification updated",
      );
      return { success: true, messageId: result.ts ?? delivery.messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, chatId: delivery.destination, messageTs: delivery.messageId },
        "Failed to update Slack notification",
      );
      return { success: false, error: message };
    }
  }
}
