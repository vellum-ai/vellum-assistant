/**
 * Slack channel adapter — delivers notifications to Slack DMs
 * via the gateway's channel-reply endpoint.
 *
 * Follows the same delivery pattern as the Telegram adapter: POST to
 * the gateway's `/deliver/slack` endpoint with a chat ID (the guardian's
 * Slack DM channel ID) and text payload. The gateway forwards the
 * message to the Slack Web API.
 */

import { getGatewayInternalBaseUrl } from "../../config/env.js";
import { mintDaemonDeliveryToken } from "../../runtime/auth/token-service.js";
import { deliverChannelReply } from "../../runtime/gateway-client.js";
import { getLogger } from "../../util/logger.js";
import { isConversationSeedSane } from "../conversation-seed-composer.js";
import {
  buildAccessRequestIdentityLine,
  buildAccessRequestInviteDirective,
  nonEmpty,
  sanitizeIdentityField,
} from "../copy-composer.js";
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
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
export function buildAccessRequestBlocks(
  payload: Record<string, unknown>,
): unknown[] {
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

  // Divider before instructions
  blocks.push({ type: "divider" });

  // Approval code instructions
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

    const gatewayBase = getGatewayInternalBaseUrl();
    const deliverUrl = `${gatewayBase}/deliver/slack`;

    const messageText = resolveSlackMessageText(payload);

    // Build Block Kit blocks for access request notifications
    const isAccessRequest =
      payload.sourceEventName === "ingress.access_request" &&
      payload.contextPayload != null;

    try {
      if (isAccessRequest) {
        const blocks = buildAccessRequestBlocks(payload.contextPayload!);
        await deliverChannelReply(
          deliverUrl,
          { chatId, text: messageText, blocks },
          mintDaemonDeliveryToken(),
        );
      } else {
        await deliverChannelReply(
          deliverUrl,
          { chatId, text: messageText, useBlocks: true },
          mintDaemonDeliveryToken(),
        );
      }

      log.info(
        { sourceEventName: payload.sourceEventName, chatId },
        "Slack notification delivered",
      );

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, sourceEventName: payload.sourceEventName, chatId },
        "Failed to deliver Slack notification",
      );
      return { success: false, error: message };
    }
  }
}
