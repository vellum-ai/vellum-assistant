/**
 * Slack channel adapter — delivers notifications to Slack DMs
 * using native Card blocks for approval notifications.
 *
 * Approval notifications (access requests, tool approvals) render as a
 * single Slack Card block with Approve/Reject action buttons, plus
 * optional companion context blocks for details that exceed the card's
 * character limits. Non-approval notifications use standard Block Kit
 * text sections.
 *
 * Card content is pre-resolved by the broadcaster as `approvalCardData`
 * (from `approval-card-data.ts`), so the adapter only handles Slack-native
 * rendering — no payload parsing.
 *
 * Card block reference:
 * https://docs.slack.dev/reference/block-kit/blocks/card-block
 */

import { sendSlackReply } from "../../messaging/providers/slack/send.js";
import type { ApprovalUIMetadata } from "../../runtime/channel-approval-types.js";
import { getLogger } from "../../util/logger.js";
import { buildAccessRequestInviteDirective } from "../access-request-copy.js";
import type {
  AccessRequestCardData,
  ApprovalCardData,
  ToolApprovalCardData,
} from "../approval-card-data.js";
import { isConversationSeedSane } from "../conversation-seed-composer.js";
import { nonEmpty } from "../notification-utils.js";
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

// ---------------------------------------------------------------------------
// Text resolution
// ---------------------------------------------------------------------------

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

/** Truncate to `maxLength`, appending "…" when exceeded. */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}

// ---------------------------------------------------------------------------
// Slack Card block builders for approval notifications
// ---------------------------------------------------------------------------

/** Build action buttons for a Slack Card block from approval metadata. */
function buildCardActions(approval: ApprovalUIMetadata): unknown[] {
  return approval.actions.map((action) => ({
    type: "button",
    text: { type: "plain_text", text: action.label, emoji: true },
    action_id: `apr:${approval.requestId}:${action.id}`,
    value: `apr:${approval.requestId}:${action.id}`,
    ...(action.id === "reject" ? { style: "danger" } : { style: "primary" }),
  }));
}

// ---------------------------------------------------------------------------
// Access request card (renders from pre-resolved AccessRequestCardData)
// ---------------------------------------------------------------------------

function buildAccessRequestSlackBlocks(
  data: AccessRequestCardData,
  approval: ApprovalUIMetadata,
): unknown[] {
  const blocks: unknown[] = [];

  // Subtitle: requester identity
  const subtitleParts = [data.displayName];
  if (data.username && data.username !== data.displayName) {
    subtitleParts.push(`(@${data.username})`);
  }
  if (data.sourceChannel) subtitleParts.push(`via ${data.sourceChannel}`);
  const subtitle = truncate(subtitleParts.join(" "), 150);

  // Body: message preview
  let body: string;
  if (data.messagePreview) {
    const trimmed = truncate(data.messagePreview, 200 - 6);
    body = `> _"${trimmed}"_`;
  } else {
    body = "Requesting access to the assistant";
  }

  // Warnings as subtext
  const subtext =
    data.warnings.length > 0
      ? truncate(data.warnings.map((w) => `:warning: ${w}`).join(" · "), 200)
      : undefined;

  const card: Record<string, unknown> = {
    type: "card",
    title: { type: "plain_text", text: "Access Request" },
    subtitle: { type: "mrkdwn", text: subtitle },
    body: { type: "mrkdwn", text: body },
    actions: buildCardActions(approval),
  };
  if (subtext) card.subtext = { type: "mrkdwn", text: subtext };
  blocks.push(card);

  // Context: source permalink (Slack-specific)
  if (data.sourceChannel === "slack" && data.conversationExternalId) {
    let sourceText: string;
    if (data.isSlackDm) {
      sourceText = data.messagePermalink
        ? `Source: Slack — Direct message · <${data.messagePermalink}|View message>`
        : "Source: Slack — Direct message";
    } else {
      sourceText = data.messagePermalink
        ? `Source: Slack — <#${data.conversationExternalId}> · <${data.messagePermalink}|View message>`
        : `Source: Slack — <#${data.conversationExternalId}>`;
    }
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: sourceText }],
    });
  }

  // Context: stable requester ID (when it adds info beyond subtitle)
  if (
    data.externalId &&
    data.externalId !== data.displayName &&
    data.externalId !== data.username
  ) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `ID: ${data.externalId}` }],
    });
  }

  // Context: invite directive
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: buildAccessRequestInviteDirective() }],
  });

  // Context: guardian verification hint
  if (
    (data.guardianResolutionSource === "vellum-anchor" ||
      data.guardianResolutionSource === "none") &&
    data.sourceChannel
  ) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_You haven't verified your identity on ${data.sourceChannel} yet. If this was you trying to message your assistant, say "help me verify as guardian on ${data.sourceChannel}" to set up direct access._`,
        },
      ],
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Tool approval card (renders from pre-resolved ToolApprovalCardData)
// ---------------------------------------------------------------------------

function buildToolApprovalSlackBlocks(
  data: ToolApprovalCardData,
  approval: ApprovalUIMetadata,
  messageText: string,
): unknown[] {
  const blocks: unknown[] = [];

  const title =
    data.kind === "tool_grant"
      ? "Tool Grant Request"
      : approval.permissionDetails
        ? "Tool Approval"
        : "Approval Request";

  let subtitle: string | undefined;
  if (data.requester !== "Someone") {
    subtitle = truncate(
      `${data.toolName} — requested by ${data.requester}`,
      150,
    );
  } else {
    subtitle = truncate(data.toolName, 150);
  }

  const needsOverflow = messageText.length > 200;
  const card: Record<string, unknown> = {
    type: "card",
    title: { type: "plain_text", text: title },
    body: {
      type: "mrkdwn",
      text: needsOverflow ? truncate(messageText, 197) + " ↓" : messageText,
    },
    actions: buildCardActions(approval),
  };
  if (subtitle) card.subtitle = { type: "mrkdwn", text: subtitle };
  blocks.push(card);

  if (needsOverflow) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(messageText, 3000) },
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Unified approval block dispatcher
// ---------------------------------------------------------------------------

/**
 * Build Slack blocks for any notification carrying approval context.
 * Dispatches to the appropriate card builder based on pre-resolved card data.
 */
function buildApprovalNotificationBlocks(
  cardData: ApprovalCardData,
  approval: ApprovalUIMetadata,
  messageText: string,
): unknown[] {
  if (cardData.kind === "access_request") {
    return buildAccessRequestSlackBlocks(cardData, approval);
  }
  return buildToolApprovalSlackBlocks(cardData, approval, messageText);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

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

    try {
      const result =
        payload.approvalContext && payload.approvalCardData
          ? await sendSlackReply(chatId, messageText, {
              blocks: buildApprovalNotificationBlocks(
                payload.approvalCardData,
                payload.approvalContext,
                messageText,
              ),
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
