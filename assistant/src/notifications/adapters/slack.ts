/**
 * Slack channel adapter — delivers notifications to Slack DMs
 * using native Card blocks for approval notifications.
 *
 * Approval notifications (access requests, tool approvals) render as a
 * single Slack Card block with Approve/Reject action buttons. Text that
 * exceeds the card body's 200-character cap continues in a companion
 * section block below the card. Non-approval notifications use standard
 * Block Kit text sections.
 *
 * Card block reference:
 * https://docs.slack.dev/reference/block-kit/blocks/card-block
 */

import type { Button, CardBlock, ContextBlock, KnownBlock } from "@slack/types";

import { sendSlackReply } from "../../messaging/providers/slack/send.js";
import type { ApprovalUIMetadata } from "../../runtime/channel-approval-types.js";
import { getLogger } from "../../util/logger.js";
import {
  accessRequestCardSubtitle,
  accessRequestCardTitle,
  type AccessRequestCardView,
  buildAccessRequestCardView,
  buildAccessRequestInviteDirective,
} from "../access-request-copy.js";
import { truncate } from "../notification-utils.js";
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
  ChannelUpdateContext,
  ChannelUpdatePayload,
  DeliveryResult,
  NotificationChannel,
} from "../types.js";
import { resolveMessageText } from "./shared.js";

const log = getLogger("notif-adapter-slack");

// ---------------------------------------------------------------------------
// Slack Card block builders for approval notifications
// ---------------------------------------------------------------------------

/** Translate a surface-agnostic emphasis into Slack's button style token. */
function slackStyleForEmphasis(
  emphasis: "primary" | "secondary" | "destructive",
): { style: "primary" | "danger" } | Record<string, never> {
  switch (emphasis) {
    case "primary":
      return { style: "primary" };
    case "destructive":
      return { style: "danger" };
    case "secondary":
      return {};
  }
}

/**
 * Build action buttons for a Slack Card block from approval metadata.
 *
 * Actions carrying an `emphasis` (introduction cards) render it directly, so
 * emphasis policy stays in introduction-policy.ts. Actions without one (tool
 * approvals) fall back to positional styling: first action `primary`,
 * `reject` `danger`.
 */
function buildCardActions(approval: ApprovalUIMetadata): Button[] {
  return approval.actions.map((action, index) => ({
    type: "button",
    text: { type: "plain_text", text: action.label, emoji: true },
    action_id: `apr:${approval.requestId}:${action.id}`,
    value: `apr:${approval.requestId}:${action.id}`,
    ...(action.emphasis
      ? slackStyleForEmphasis(action.emphasis)
      : action.id === "reject"
        ? { style: "danger" }
        : index === 0
          ? { style: "primary" }
          : {}),
  }));
}

// ---------------------------------------------------------------------------
// Access request card
// ---------------------------------------------------------------------------

/** Concise requester identity for the card subtitle (≤150 chars). */
function buildAccessRequestSubtitle(view: AccessRequestCardView): string {
  const parts = [view.displayName];

  if (view.username && view.username !== view.displayName) {
    parts.push(`(@${view.username})`);
  }

  if (view.sourceChannel) {
    parts.push(`via ${view.sourceChannel}`);
  }

  return truncate(parts.join(" "), 150);
}

/** Card body: message preview when available, otherwise a default label. */
function buildAccessRequestBody(view: AccessRequestCardView): string {
  if (view.messagePreview) {
    // Truncate content before wrapping so formatting chars stay balanced.
    // Wrapper `> _"..."_` is 6 chars; reserve space for them.
    const trimmed = truncate(view.messagePreview, 200 - 6);
    return `> _"${trimmed}"_`;
  }
  return accessRequestCardSubtitle(view.admitted);
}

/** Source-channel context block with Slack permalink when available. */
function buildSourceContextBlock(
  view: AccessRequestCardView,
): ContextBlock | undefined {
  if (view.sourceChannel !== "slack" || !view.conversationExternalId) {
    return undefined;
  }

  const permalink = view.messagePermalink;

  let sourceText: string;
  if (view.isSlackDm) {
    sourceText = permalink
      ? `Source: Slack — Direct message · <${permalink}|View message>`
      : "Source: Slack — Direct message";
  } else {
    sourceText = permalink
      ? `Source: Slack — <#${view.conversationExternalId}> · <${permalink}|View message>`
      : `Source: Slack — <#${view.conversationExternalId}>`;
  }

  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: sourceText }],
  };
}

/** Stable requester identifier context block (external ID when it adds info). */
function buildRequesterIdBlock(
  view: AccessRequestCardView,
): ContextBlock | undefined {
  const safeExternalId = view.externalId;
  if (!safeExternalId) {
    return undefined;
  }

  if (safeExternalId === view.displayName || safeExternalId === view.username) {
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
 *   Card — title + subtitle (identity) + body (preview) + actions
 *   Context — security warnings (revoked/restricted/stranger), when present
 *   Context — source permalink (when the request is from Slack)
 *   Context — stable requester ID (when it adds info beyond subtitle)
 *   Context — invite directive
 *   Context — guardian verification note (conditional)
 */
function buildAccessRequestCardBlocks(
  payload: ChannelDeliveryPayload,
): KnownBlock[] {
  const approval = payload.approvalContext!;
  const view = buildAccessRequestCardView(payload.accessRequestContext!);
  const blocks: KnownBlock[] = [];

  const subtitle = buildAccessRequestSubtitle(view);
  const body = buildAccessRequestBody(view);

  const warningsText =
    view.warnings.length > 0
      ? truncate(view.warnings.map((w) => `:warning: ${w}`).join(" · "), 200)
      : undefined;

  const card: CardBlock = {
    type: "card",
    title: {
      type: "mrkdwn",
      text: accessRequestCardTitle(view.admitted),
    },
    subtitle: { type: "mrkdwn", text: subtitle },
    body: { type: "mrkdwn", text: body },
    actions: buildCardActions(approval),
  };
  blocks.push(card);

  // Security warnings (revoked / restricted / stranger) render in a context
  // block under the card. Slack's card block schema has no field for them
  // (https://docs.slack.dev/reference/block-kit/blocks/card-block) and Slack
  // silently drops unknown card fields, so a dedicated block is needed to
  // surface them to the guardian.
  if (warningsText) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: warningsText }],
    });
  }

  const sourceContext = buildSourceContextBlock(view);
  if (sourceContext) {
    blocks.push(sourceContext);
  }

  const idBlock = buildRequesterIdBlock(view);
  if (idBlock) {
    blocks.push(idBlock);
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: buildAccessRequestInviteDirective() }],
  });

  if (
    (view.guardianResolutionSource === "vellum-anchor" ||
      view.guardianResolutionSource === "none") &&
    view.sourceChannel
  ) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_You haven't verified your identity on ${view.sourceChannel} yet. If this was you trying to message your assistant, say "help me verify as guardian on ${view.sourceChannel}" to set up direct access._`,
        },
      ],
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Tool approval card
// ---------------------------------------------------------------------------

/** Slack caps a card block's `body` text at 200 characters. */
const CARD_BODY_MAX_LENGTH = 200;

/** Marker signalling the card body continues in the section below. */
const CARD_BODY_CONTINUATION_MARKER = " ↓";

/**
 * Split message text so the head fits Slack's card body cap (marker
 * included) and the tail continues in a companion section below the card.
 * Splits on the last whitespace inside the budget when there is one, so
 * neither piece cuts mid-word. Text within the cap needs no split.
 */
function splitAtCardBodyLimit(text: string): { head: string; tail?: string } {
  if (text.length <= CARD_BODY_MAX_LENGTH) {
    return { head: text };
  }

  const budget = CARD_BODY_MAX_LENGTH - CARD_BODY_CONTINUATION_MARKER.length;
  const window = text.slice(0, budget + 1);
  const lastWhitespace = window.search(/\s\S*$/);
  const cut = lastWhitespace > 0 ? lastWhitespace : budget;

  return {
    head: text.slice(0, cut).trimEnd() + CARD_BODY_CONTINUATION_MARKER,
    tail: text.slice(cut).trimStart(),
  };
}

/**
 * Build Slack blocks for a tool approval notification using a native Card block.
 *
 * Layout:
 *   Card — title + subtitle (tool + requester) + body (notification text) + actions
 *   Section — continuation of body text exceeding the card's 200-char cap
 */
function buildToolApprovalCardBlocks(
  payload: ChannelDeliveryPayload,
  messageText: string,
): KnownBlock[] {
  const approval = payload.approvalContext!;
  const blocks: KnownBlock[] = [];

  const details = approval.permissionDetails;
  const toolName = details?.toolName;
  const requester = details?.requesterIdentifier;
  let subtitle: string | undefined;
  if (toolName && requester) {
    subtitle = truncate(`${toolName} — requested by ${requester}`, 150);
  } else if (toolName) {
    subtitle = truncate(toolName, 150);
  }

  const { head, tail } = splitAtCardBodyLimit(messageText);
  const card: CardBlock = {
    type: "card",
    title: {
      type: "mrkdwn",
      text: details ? "Tool Approval" : "Approval Request",
    },
    body: { type: "mrkdwn", text: head },
    actions: buildCardActions(approval),
  };
  if (subtitle) {
    card.subtitle = { type: "mrkdwn", text: subtitle };
  }
  blocks.push(card);

  // The companion section carries only the remainder — repeating the full
  // text would render the same message twice (once in the card, once below).
  if (tail) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(`… ${tail}`, 3000) },
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
 *
 * Exported for characterization tests of the approval-card block output.
 */
export function buildApprovalNotificationBlocks(
  payload: ChannelDeliveryPayload,
  messageText: string,
): KnownBlock[] {
  if (
    payload.sourceEventName === "ingress.access_request" &&
    payload.accessRequestContext != null
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

    const messageText = resolveMessageText(payload);

    try {
      // `approval` rides along with the prebuilt card blocks so the send
      // layer treats a rejected Block Kit payload as an approval prompt:
      // its block-free retry re-attaches `plainTextFallback` reply
      // instructions instead of posting text with no way to respond.
      const result = payload.approvalContext
        ? await sendSlackReply(chatId, messageText, {
            blocks: buildApprovalNotificationBlocks(payload, messageText),
            approval: payload.approvalContext,
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
