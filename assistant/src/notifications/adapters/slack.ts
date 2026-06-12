/**
 * Slack channel adapter — delivers notifications to Slack DMs
 * by calling the Slack Web API directly.
 */

import { sendSlackReply } from "../../messaging/providers/slack/send.js";
import { getLogger } from "../../util/logger.js";
import {
  buildAccessRequestIdentityLine,
  buildAccessRequestInviteDirective,
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
  const blocks: unknown[] = [];

  // Header
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "New access request", emoji: true },
  });

  // Requester identity section
  const identityLine = buildAccessRequestIdentityLine(payload);
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: identityLine },
  });

  // Build fields for structured requester details
  const fields: Array<{ type: "mrkdwn"; text: string }> = [];

  const senderIdentifier = nonEmpty(
    typeof payload.senderIdentifier === "string"
      ? sanitizeIdentityField(payload.senderIdentifier)
      : undefined,
  );
  if (senderIdentifier) {
    fields.push({ type: "mrkdwn", text: `*Name:*\n${senderIdentifier}` });
  }

  const actorUsername = nonEmpty(
    typeof payload.actorUsername === "string"
      ? sanitizeIdentityField(payload.actorUsername)
      : undefined,
  );
  if (actorUsername) {
    fields.push({ type: "mrkdwn", text: `*Username:*\n@${actorUsername}` });
  }

  const sourceChannel = nonEmpty(
    typeof payload.sourceChannel === "string"
      ? payload.sourceChannel
      : undefined,
  );
  if (sourceChannel) {
    fields.push({ type: "mrkdwn", text: `*Channel:*\n${sourceChannel}` });
  }

  const actorExternalId = nonEmpty(
    typeof payload.actorExternalId === "string"
      ? sanitizeIdentityField(payload.actorExternalId)
      : undefined,
  );
  if (actorExternalId && actorExternalId !== senderIdentifier) {
    fields.push({ type: "mrkdwn", text: `*ID:*\n${actorExternalId}` });
  }

  if (fields.length > 0) {
    blocks.push({
      type: "section",
      fields,
    });
  }

  // Previously revoked warning
  const previousMemberStatus =
    typeof payload.previousMemberStatus === "string"
      ? payload.previousMemberStatus
      : undefined;
  if (previousMemberStatus === "revoked") {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: ":warning: This user was previously revoked.",
        },
      ],
    });
  }

  // Trust signal warnings
  const isStranger = payload.isStranger === true;
  const isRestricted = payload.isRestricted === true;
  if (isStranger || isRestricted) {
    const warnings: string[] = [];
    if (isStranger) {
      warnings.push(":warning: External Slack user (not in this workspace)");
    }
    if (isRestricted) {
      warnings.push(":warning: Guest / restricted account");
    }
    blocks.push({
      type: "context",
      elements: warnings.map((w) => ({ type: "mrkdwn", text: w })),
    });
  }

  // Divider before action buttons
  blocks.push({ type: "divider" });

  // Interactive approval buttons (replaces text-based code instructions)
  const requestId = nonEmpty(
    typeof payload.requestId === "string" ? payload.requestId : undefined,
  );
  if (requestId) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve", emoji: true },
          style: "primary",
          action_id: `apr:${requestId}:approve_trusted`,
          value: `apr:${requestId}:approve_trusted`,
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Require handshake",
            emoji: true,
          },
          action_id: `apr:${requestId}:approve_once`,
          value: `apr:${requestId}:approve_once`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject", emoji: true },
          style: "danger",
          action_id: `apr:${requestId}:reject`,
          value: `apr:${requestId}:reject`,
        },
      ],
    });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_Approve = mark trusted, immediate access. Require handshake = send them a code they must reply with to verify._",
        },
      ],
    });
  } else {
    // Fallback to text instructions when requestId is unavailable
    const requestCode = nonEmpty(
      typeof payload.requestCode === "string" ? payload.requestCode : undefined,
    );
    if (requestCode) {
      const code = requestCode.toUpperCase();
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Reply *${code} approve* to grant access or *${code} reject* to deny.`,
        },
      });
    }
  }

  // Invite directive
  const inviteDirective = buildAccessRequestInviteDirective();
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: inviteDirective }],
  });

  // Guardian verification note
  const guardianResolutionSource =
    typeof payload.guardianResolutionSource === "string"
      ? payload.guardianResolutionSource
      : undefined;
  if (
    (guardianResolutionSource === "vellum-anchor" ||
      guardianResolutionSource === "none") &&
    sourceChannel
  ) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_You haven't verified your identity on ${sourceChannel} yet. If this was you trying to message your assistant, say "help me verify as guardian on ${sourceChannel}" to set up direct access._`,
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
