/**
 * Recover a tool-approval card's triggering-message facts from the source of
 * truth — the persisted conversation message — at escalation time.
 *
 * A tool-grant escalation fires mid-turn, several steps removed from ingress,
 * so (unlike an access request, which captures the live inbound at the ACL
 * stage) the triggering message is not in hand. But it survives: every inbound
 * Slack message is persisted as a conversation message carrying typed
 * `SlackMessageMetadata` (`channelTs`, `channelId`, `channelName`, `displayName`,
 * `actorExternalUserId`). This module reads it back by `conversationId` — the
 * same conversation-keyed resolution pattern as `getBindingByConversation` —
 * giving the guardian the requester's actual words and an exact-message
 * permalink without threading message provenance through `ToolContext`.
 *
 * The selection is pure and unit-tested; the store read is a thin wrapper.
 */

import type { MessageRow } from "../memory/conversation-crud.js";
import { getRecentUserMessages } from "../memory/recent-user-messages.js";
import { readSlackMetadataFromMessageMetadata } from "../messaging/providers/slack/message-metadata.js";
import type { ToolGrantGuardianPayload } from "./guardian-question-mode.js";
import { nonEmpty } from "./notification-utils.js";

/**
 * Triggering-message facts for a guardian tool-approval card. The payload-shaped
 * fields are derived from the Zod-inferred payload type (not hand-declared) so
 * they can't drift from what the producer writes into the payload; the resolver
 * spreads them straight in. `actorDisplayName` is the one extra — it feeds the
 * payload's `requesterIdentifier` after the caller merges context fallbacks.
 */
export type ToolApprovalSourceFacts = Pick<
  ToolGrantGuardianPayload,
  "messagePreview" | "conversationExternalId" | "messageTs" | "channelName"
> & {
  /** Sender display name recorded on the source message (Slack `displayName`). */
  actorDisplayName?: string;
};

/** How many recent user messages to scan when locating the triggering message. */
const RECENT_USER_MESSAGE_SCAN_LIMIT = 10;

/**
 * Choose the message that triggered an escalation from a conversation's recent
 * user messages (newest first) and project its facts.
 *
 * Prefer the escalating actor's own most-recent message (Slack metadata names
 * them via `actorExternalUserId`) for exact attribution; otherwise fall back to
 * the most recent user message, which is the trigger in the common single-turn
 * case and supplies preview text even for non-Slack sources (no permalink).
 */
export function selectTriggeringMessageFacts(
  recentUserMessages: MessageRow[],
  requesterExternalUserId?: string,
): ToolApprovalSourceFacts {
  const withSlackMeta = recentUserMessages.map((row) => ({
    row,
    slackMeta: readSlackMetadataFromMessageMetadata(row.metadata),
  }));

  const chosen =
    (requesterExternalUserId
      ? withSlackMeta.find(
          (m) => m.slackMeta?.actorExternalUserId === requesterExternalUserId,
        )
      : undefined) ?? withSlackMeta[0];

  if (!chosen) return {};

  const { row, slackMeta } = chosen;
  return {
    messagePreview: nonEmpty(row.content),
    conversationExternalId: nonEmpty(slackMeta?.channelId),
    messageTs: nonEmpty(slackMeta?.channelTs),
    channelName: nonEmpty(slackMeta?.channelName),
    actorDisplayName: nonEmpty(slackMeta?.displayName),
  };
}

/**
 * Resolve the triggering-message facts for a tool-approval escalation by
 * reading the conversation's recent user messages. Returns empty facts when
 * nothing is recoverable; callers degrade gracefully (no preview / no link).
 */
export function resolveToolApprovalSourceFacts(
  conversationId: string,
  requesterExternalUserId?: string,
): ToolApprovalSourceFacts {
  const recent = getRecentUserMessages(
    conversationId,
    RECENT_USER_MESSAGE_SCAN_LIMIT,
  );
  return selectTriggeringMessageFacts(recent, requesterExternalUserId);
}
