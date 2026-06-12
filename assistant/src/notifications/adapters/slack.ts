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
    // For Slack, show the conversation context (DM vs channel link).
    const conversationExternalId =
      typeof payload.conversationExternalId === "string"
        ? payload.conversationExternalId
        : undefined;
    const messageTs =
      typeof payload.messageTs === "string" ? payload.messageTs : undefined;
    let channelDisplay = sourceChannel;
    if (sourceChannel === "slack" && conversationExternalId) {
      // Build a permalink to the specific message when we have the timestamp.
      // Format: https://slack.com/archives/{channelId}/p{ts_without_dot}
      // This is workspace-agnostic and resolves for any authenticated viewer.
      const permalink =
        messageTs && conversationExternalId
          ? `https://slack.com/archives/${conversationExternalId}/p${messageTs.replace(".", "")}`
          : undefined;

      // C = public/private channels, G = group DMs / MPIMs / legacy private channels.
      // Both support the <#ID> mrkdwn deep-link. D = 1:1 DMs (no linkable channel).
      if (/^[CG][A-Z0-9]+$/i.test(conversationExternalId)) {
        channelDisplay = permalink
          ? `Slack — <#${conversationExternalId}> · <${permalink}|View message>`
          : `Slack — <#${conversationExternalId}>`;
      } else {
        channelDisplay = permalink
          ? `Slack — Direct message · <${permalink}|View message>`
          : "Slack — Direct message";
      }
    }
    fields.push({ type: "mrkdwn", text: `*Source:*\n${channelDisplay}` });
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

  // Trust signal warnings (Slack-specific)
  const trustWarnings: string[] = [];
  if (payload.isStranger === true) {
    trustWarnings.push(":warning: External Slack user (not in this workspace)");
  }
  if (payload.isRestricted === true) {
    trustWarnings.push(":warning: Guest / restricted account");
  }
  if (trustWarnings.length > 0) {
    blocks.push({
      type: "context",
      elements: trustWarnings.map((text) => ({ type: "mrkdwn", text })),
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
