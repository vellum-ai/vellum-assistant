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
 * Card block reference:
 * https://docs.slack.dev/reference/block-kit/blocks/card-block
 */

import { sendSlackReply } from "../../messaging/providers/slack/send.js";
import type { ApprovalUIMetadata } from "../../runtime/channel-approval-types.js";
import { getLogger } from "../../util/logger.js";
import {
  buildAccessRequestInviteDirective,
  buildAccessRequestWarnings,
  buildSlackMessagePermalink,
  isSlackDmConversation,
  parseAccessRequestPayload,
  type ParsedAccessRequestPayload,
} from "../access-request-copy.js";
import { isConversationSeedSane } from "../conversation-seed-composer.js";
import {
  nonEmpty,
  sanitizeIdentityField,
  sanitizeMessagePreview,
} from "../notification-utils.js";
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
// Access request card
// ---------------------------------------------------------------------------

/** Concise requester identity for the card subtitle (≤150 chars). */
function buildAccessRequestSubtitle(p: ParsedAccessRequestPayload): string {
  const rawName = nonEmpty(p.actorDisplayName) ?? nonEmpty(p.senderIdentifier);
  const displayName = rawName ? sanitizeIdentityField(rawName) : "Someone";
  const parts = [displayName];

  const username = nonEmpty(p.actorUsername);
  if (username) {
    const safe = sanitizeIdentityField(username);
    if (safe !== displayName) parts.push(`(@${safe})`);
  }

  if (p.sourceChannel) parts.push(`via ${p.sourceChannel}`);

  return truncate(parts.join(" "), 150);
}

/** Card body: message preview when available, otherwise a default label. */
function buildAccessRequestBody(p: ParsedAccessRequestPayload): string {
  if (p.messagePreview) {
    const sanitized = sanitizeMessagePreview(p.messagePreview);
    if (sanitized) {
      // Truncate content before wrapping so formatting chars stay balanced.
      // Wrapper `> _"..."_` is 6 chars; reserve space for them.
      const trimmed = truncate(sanitized, 200 - 6);
      return `> _"${trimmed}"_`;
    }
  }
  return "Requesting access to the assistant";
}

/** Source-channel context block with Slack permalink when available. */
function buildSourceContextBlock(
  p: ParsedAccessRequestPayload,
): unknown | undefined {
  if (p.sourceChannel !== "slack" || !p.conversationExternalId) {
    return undefined;
  }

  const permalink = p.messageTs
    ? buildSlackMessagePermalink(p.conversationExternalId, p.messageTs)
    : undefined;

  let sourceText: string;
  if (isSlackDmConversation(p.conversationExternalId)) {
    sourceText = permalink
      ? `Source: Slack — Direct message · <${permalink}|View message>`
      : "Source: Slack — Direct message";
  } else {
    sourceText = permalink
      ? `Source: Slack — <#${p.conversationExternalId}> · <${permalink}|View message>`
      : `Source: Slack — <#${p.conversationExternalId}>`;
  }

  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: sourceText }],
  };
}

/** Stable requester identifier context block (external ID when it adds info). */
function buildRequesterIdBlock(
  p: ParsedAccessRequestPayload,
): unknown | undefined {
  const safeExternalId = nonEmpty(
    p.actorExternalId ? sanitizeIdentityField(p.actorExternalId) : undefined,
  );
  if (!safeExternalId) return undefined;

  const displayedName = nonEmpty(
    p.actorDisplayName
      ? sanitizeIdentityField(p.actorDisplayName)
      : p.senderIdentifier
        ? sanitizeIdentityField(p.senderIdentifier)
        : undefined,
  );
  const displayedUsername = nonEmpty(
    p.actorUsername ? sanitizeIdentityField(p.actorUsername) : undefined,
  );
  if (
    safeExternalId === displayedName ||
    safeExternalId === displayedUsername
  ) {
    return undefined;
  }

  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: `ID: ${safeExternalId}` }],
  };
}

/**
 * Build Slack blocks for an access request using a native Card block.
 *
 * Layout:
 *   Card — title + subtitle (identity) + body (preview) + actions + subtext (warnings)
 *   Context — source permalink (when the request is from Slack)
 *   Context — stable requester ID (when it adds info beyond subtitle)
 *   Context — invite directive
 *   Context — guardian verification note (conditional)
 */
function buildAccessRequestCardBlocks(
  payload: ChannelDeliveryPayload,
): unknown[] {
  const approval = payload.approvalContext!;
  const p = parseAccessRequestPayload(payload.contextPayload!);
  const blocks: unknown[] = [];

  const subtitle = buildAccessRequestSubtitle(p);
  const body = buildAccessRequestBody(p);

  const warnings = buildAccessRequestWarnings(p);
  const subtext =
    warnings.length > 0
      ? truncate(warnings.map((w) => `:warning: ${w}`).join(" · "), 200)
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

  const sourceContext = buildSourceContextBlock(p);
  if (sourceContext) blocks.push(sourceContext);

  const idBlock = buildRequesterIdBlock(p);
  if (idBlock) blocks.push(idBlock);

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: buildAccessRequestInviteDirective() }],
  });

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

// ---------------------------------------------------------------------------
// Tool approval card
// ---------------------------------------------------------------------------

/**
 * Build Slack blocks for a tool approval notification using a native Card block.
 *
 * Layout:
 *   Card — title + subtitle (tool + requester) + body (notification text) + actions
 */
function buildToolApprovalCardBlocks(
  payload: ChannelDeliveryPayload,
  messageText: string,
): unknown[] {
  const approval = payload.approvalContext!;
  const blocks: unknown[] = [];

  const details = approval.permissionDetails;
  const toolName = details?.toolName;
  const requester = details?.requesterIdentifier;
  let subtitle: string | undefined;
  if (toolName && requester) {
    subtitle = truncate(`${toolName} — requested by ${requester}`, 150);
  } else if (toolName) {
    subtitle = truncate(toolName, 150);
  }

  const needsOverflow = messageText.length > 200;
  const card: Record<string, unknown> = {
    type: "card",
    title: {
      type: "plain_text",
      text: details ? "Tool Approval" : "Approval Request",
    },
    body: {
      type: "mrkdwn",
      text: needsOverflow ? truncate(messageText, 197) + " ↓" : messageText,
    },
    actions: buildCardActions(approval),
  };
  if (subtitle) card.subtitle = { type: "mrkdwn", text: subtitle };
  blocks.push(card);

  // When the message exceeds the card body limit, show the full text in a
  // companion section so the approver can see the complete command/context.
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
 * Dispatches to the appropriate card builder based on source event type.
 */
function buildApprovalNotificationBlocks(
  payload: ChannelDeliveryPayload,
  messageText: string,
): unknown[] {
  if (
    payload.sourceEventName === "ingress.access_request" &&
    payload.contextPayload != null
  ) {
    return buildAccessRequestCardBlocks(payload);
  }

  return buildToolApprovalCardBlocks(payload, messageText);
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
      const result = payload.approvalContext
        ? await sendSlackReply(chatId, messageText, {
            blocks: buildApprovalNotificationBlocks(payload, messageText),
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
