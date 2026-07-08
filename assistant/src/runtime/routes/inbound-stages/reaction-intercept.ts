/**
 * Slack reaction intercept stage.
 *
 * Reactions are passive channel signals — not messages, and not access
 * attempts. They are dispatched here *before* the message pipeline (ACL,
 * admission floor, disk-pressure block, conversation binding) so that:
 *
 *   - a 👍 never triggers an ingress access challenge / verification handshake
 *     or an access-request notification (LUM-2489),
 *   - a stranger's reaction creates no conversation, binding, or transcript
 *     row — it is dropped as channel noise,
 *   - a known contact's reaction is recorded as an inline transcript signal,
 *   - a guardian's reaction on an approval card is routed through the canonical
 *     guardian decision pipeline (the same path as buttons and text replies).
 *
 * The reactor's trust is read solely from the gateway-stamped verdict on
 * `sourceMetadata`; a missing/failed/contradictory verdict fails closed to
 * `unknown` (drop). Reactions never drive an agent turn.
 */
import type { SourceMetadata } from "@vellumai/gateway-client";

import type { ChannelId, InterfaceId } from "../../../channels/types.js";
import { getDiskPressureStatus } from "../../../daemon/disk-pressure-guard.js";
import { classifyDiskPressureTurnPolicy } from "../../../daemon/disk-pressure-policy.js";
import {
  type SlackMessageMetadata,
  writeSlackMetadata,
} from "../../../messaging/providers/slack/message-metadata.js";
import { addMessage } from "../../../persistence/conversation-crud.js";
import {
  clearPayload,
  linkMessage,
  recordInbound,
} from "../../../persistence/delivery-crud.js";
import { markProcessed } from "../../../persistence/delivery-status.js";
import { upsertBinding } from "../../../persistence/external-conversation-store.js";
import { getLogger } from "../../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../assistant-scope.js";
import type { ApprovalConversationGenerator } from "../../http-types.js";
import {
  actorTrustContextFromVerdict,
  verdictUsability,
} from "../../trust-verdict-consumer.js";
import { handleGuardianReplyIntercept } from "./guardian-reply-intercept.js";

const log = getLogger("runtime-http");

/**
 * Detect a Slack reaction event by inspecting the inbound payload's
 * `callbackData` prefix. The gateway encodes reactions as a unified
 * `SlackInboundEvent` with `callbackData` of the form `reaction:<emoji>`
 * (added) or `reaction_removed:<emoji>` (removed) — see
 * `gateway/src/slack/normalize.ts`. This helper centralizes that convention
 * so the daemon can route reactions to this dedicated stage instead of the
 * agent-response pipeline.
 */
export function isSlackReactionEvent(body: {
  sourceChannel?: string;
  callbackData?: string;
}): boolean {
  if (body.sourceChannel !== "slack") return false;
  const cb = body.callbackData;
  if (typeof cb !== "string") return false;
  return cb.startsWith("reaction:") || cb.startsWith("reaction_removed:");
}

/**
 * Parse a reaction `callbackData` string into its op (added/removed) and
 * emoji name. Returns `null` when the input is not a reaction prefix or
 * when the emoji portion is empty.
 */
export function parseSlackReactionCallbackData(
  callbackData: string,
): { op: "added" | "removed"; emoji: string } | null {
  let op: "added" | "removed";
  let emoji: string;
  if (callbackData.startsWith("reaction_removed:")) {
    op = "removed";
    emoji = callbackData.slice("reaction_removed:".length);
  } else if (callbackData.startsWith("reaction:")) {
    op = "added";
    emoji = callbackData.slice("reaction:".length);
  } else {
    return null;
  }
  if (emoji.length === 0) return null;
  return { op, emoji };
}

export interface ReactionInterceptParams {
  /** The reaction callbackData (`reaction:<emoji>` / `reaction_removed:<emoji>`). */
  callbackData: string;
  sourceChannel: ChannelId;
  sourceInterface: InterfaceId | undefined;
  conversationExternalId: string;
  externalMessageId: string;
  canonicalAssistantId: string;
  rawSenderId: string | undefined;
  canonicalSenderId: string | null;
  actorDisplayName: string | undefined;
  actorUsername: string | undefined;
  replyCallbackUrl: string | undefined;
  sourceMetadata: SourceMetadata | undefined;
  /** Slack channel display name, for the conversation binding. */
  slackChannelName: string | null;
  approvalConversationGenerator: ApprovalConversationGenerator | undefined;
}

/**
 * Handle a Slack reaction event end to end. Always consumes the event (the
 * caller dispatches here only for `isSlackReactionEvent`), returning the
 * response the top-level handler should short-circuit with.
 */
export async function handleSlackReactionIntercept(
  params: ReactionInterceptParams,
): Promise<Record<string, unknown>> {
  const {
    callbackData,
    sourceChannel,
    sourceInterface,
    conversationExternalId,
    externalMessageId,
    canonicalAssistantId,
    rawSenderId,
    canonicalSenderId,
    actorDisplayName,
    actorUsername,
    replyCallbackUrl,
    sourceMetadata,
    slackChannelName,
    approvalConversationGenerator,
  } = params;

  // Classify the reactor from the gateway-stamped verdict — the same source
  // acl-enforcement reads, gated by the same shared usability predicate. No
  // local resolver, cache warm, or IPC reads; only the trust class / guardian
  // principal matter for a reaction. An unusable verdict fails closed: the
  // caller treats `null` as `unknown` and drops.
  const usability = verdictUsability(sourceMetadata?.trustVerdict);
  const trustCtx = usability.usable
    ? actorTrustContextFromVerdict(usability.verdict, {
        sourceChannel,
        conversationExternalId,
        actorUsername,
        actorDisplayName,
      })
    : null;

  // Drop strangers before any write. `unknown` covers no contact record,
  // blocked/revoked contacts, and missing/failed verdicts — a reaction from
  // them is channel noise. Dropping here (before recordInbound/upsertBinding)
  // means no empty conversation or binding is created on their behalf.
  if (!trustCtx || trustCtx.trustClass === "unknown") {
    log.debug(
      { sourceChannel, conversationExternalId },
      "Dropping reaction from unknown actor",
    );
    return { accepted: true, reaction: "dropped_unknown_actor" };
  }

  const reactedMessageTs =
    typeof sourceMetadata?.messageId === "string"
      ? sourceMetadata.messageId
      : undefined;
  const threadTs =
    typeof sourceMetadata?.threadId === "string" &&
    sourceMetadata.threadId.trim().length > 0
      ? sourceMetadata.threadId.trim()
      : undefined;

  // Record for dedup + conversation resolution (known contacts only — strangers
  // were dropped above).
  const result = recordInbound(
    sourceChannel,
    conversationExternalId,
    externalMessageId,
    {
      sourceMessageId: reactedMessageTs,
      assistantId: canonicalAssistantId,
      sourceThreadId: threadTs,
    },
  );

  // Respect disk-pressure cleanup so reactions don't bypass storage
  // protection. Guardians resolve to `allow-cleanup-mode` (not `block`), so a
  // guardian's approval-by-reaction still flows.
  const diskPressure = classifyDiskPressureTurnPolicy(getDiskPressureStatus(), {
    sourceChannel,
    sourceInterface,
    trustContext: {
      sourceChannel,
      trustClass: trustCtx.trustClass,
    },
  });
  if (diskPressure.action === "block") {
    // Block silently: a reaction is a passive signal, so the message
    // pipeline's "storage is low, try again" notice is meaningless for an
    // emoji — there is nothing to retry. Mark the event processed and stop
    // before binding/persistence.
    if (!result.duplicate) {
      clearPayload(result.eventId);
      markProcessed(result.eventId);
    }
    return {
      accepted: true,
      duplicate: result.duplicate,
      eventId: result.eventId,
      diskPressure: "blocked",
      reason: diskPressure.reason,
    };
  }

  // Maintain the conversation binding, matching the message pipeline. Scoped to
  // the daemon's own assistant so assistant-scoped legacy routes don't clobber
  // each other's binding metadata.
  if (canonicalAssistantId === DAEMON_INTERNAL_ASSISTANT_ID) {
    upsertBinding({
      conversationId: result.conversationId,
      sourceChannel,
      externalChatId: conversationExternalId,
      externalChatName: slackChannelName,
      externalThreadId: threadTs ?? null,
      externalUserId: canonicalSenderId ?? rawSenderId ?? null,
      displayName: actorDisplayName ?? null,
      username: actorUsername ?? null,
    });
  }

  // Guardian approval-by-reaction → canonical decision pipeline, exactly like
  // buttons and text replies. Only `reaction:` (added) expresses intent;
  // `reaction_removed:` never does. `handleGuardianReplyIntercept` self-gates
  // on `trustClass === "guardian"`, so a contact's reaction returns no response
  // and falls through to persistence.
  const isReactionAdded = callbackData.startsWith("reaction:");
  if (isReactionAdded && replyCallbackUrl && !result.duplicate) {
    const reactionIntercept = await handleGuardianReplyIntercept({
      isDuplicate: result.duplicate,
      trimmedContent: "",
      hasCallbackData: true,
      callbackData,
      reactedMessageTs,
      rawSenderId,
      canonicalSenderId,
      canonicalAssistantId,
      sourceChannel,
      conversationExternalId,
      conversationId: result.conversationId,
      eventId: result.eventId,
      replyCallbackUrl,
      trustClass: trustCtx.trustClass,
      guardianPrincipalId: trustCtx.guardianPrincipalId,
      approvalConversationGenerator,
    });
    // Consumed as a guardian decision (applied, or a surfaced failure delivered
    // as an ephemeral reply). Short-circuit so we do not also persist a
    // transcript row.
    if (reactionIntercept.response) {
      return reactionIntercept.response;
    }
  }

  // Record the reaction as an inline transcript signal. Requires the reacted
  // message ts to anchor the rendering.
  if (!reactedMessageTs) {
    log.debug(
      { conversationId: result.conversationId, eventId: result.eventId },
      "Skipping reaction persistence: missing sourceMetadata.messageId",
    );
    return {
      accepted: result.accepted,
      duplicate: result.duplicate,
      eventId: result.eventId,
    };
  }

  try {
    await persistSlackReactionAsMessage({
      conversationId: result.conversationId,
      conversationExternalId,
      eventId: result.eventId,
      callbackData,
      actorDisplayName,
      threadTs,
      reactedMessageTs,
      duplicate: result.duplicate,
    });
  } catch (err) {
    log.error(
      { err, conversationId: result.conversationId, eventId: result.eventId },
      "Failed to persist Slack reaction event",
    );
  }

  return {
    accepted: result.accepted,
    duplicate: result.duplicate,
    eventId: result.eventId,
  };
}

/**
 * Persist a Slack reaction event as a `messages` row with a `slackMeta`
 * envelope so the renderer can surface it inline in the chronological
 * transcript. Reactions do not trigger an agent response — the row is written
 * and the inbound event is linked, but the agent loop is not dispatched.
 *
 * The caller is expected to have run `recordInbound` already so that
 * deduplication and conversation resolution have happened. Duplicate inbound
 * events are skipped here to keep persistence idempotent.
 */
async function persistSlackReactionAsMessage(params: {
  conversationId: string;
  conversationExternalId: string;
  eventId: string;
  callbackData: string;
  actorDisplayName?: string;
  threadTs?: string;
  reactedMessageTs: string;
  duplicate: boolean;
}): Promise<void> {
  if (params.duplicate) return;

  const parsed = parseSlackReactionCallbackData(params.callbackData);
  if (!parsed) {
    log.debug(
      {
        conversationId: params.conversationId,
        callbackData: params.callbackData,
      },
      "Skipping reaction persistence: unparseable callbackData",
    );
    return;
  }

  const slackMeta: SlackMessageMetadata = {
    source: "slack",
    channelId: params.conversationExternalId,
    channelTs: params.reactedMessageTs,
    eventKind: "reaction",
    ...(params.threadTs ? { threadTs: params.threadTs } : {}),
    ...(params.actorDisplayName
      ? { displayName: params.actorDisplayName }
      : {}),
    reaction: {
      emoji: parsed.emoji,
      targetChannelTs: params.reactedMessageTs,
      op: parsed.op,
      ...(params.actorDisplayName
        ? { actorDisplayName: params.actorDisplayName }
        : {}),
    },
  };

  // Sentinel content — Slack transcript renderers read `slackMeta` to format
  // the reaction line; the literal text is never displayed to the model.
  const persisted = await addMessage(
    params.conversationId,
    "user",
    "[reaction]",
    {
      metadata: { slackMeta: writeSlackMetadata(slackMeta) },
      skipIndexing: true,
    },
  );
  linkMessage(params.eventId, persisted.id);
  markProcessed(params.eventId);
}
