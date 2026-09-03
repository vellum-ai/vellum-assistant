/**
 * Reaction intercept stage, on any channel.
 *
 * Reactions are not messages and not access attempts. They are dispatched
 * here *before* the message pipeline (ACL, admission floor, disk-pressure
 * block, conversation binding) so that:
 *
 *   - a 👍 never triggers an ingress access challenge / verification handshake
 *     or an access-request notification (LUM-2489),
 *   - a stranger's reaction creates no conversation, binding, or transcript
 *     row — it is dropped as channel noise,
 *   - a known contact's reaction is recorded as an inline transcript signal in
 *     the conversation of the message it was attached to, whether that message
 *     arrived from the channel or the assistant posted it.
 *
 * The reactor's trust is read solely from the gateway-stamped verdict on
 * `sourceMetadata`; a missing/failed/contradictory verdict fails closed to
 * `unknown` (drop).
 *
 * One reaction shape addresses the assistant rather than annotating the
 * room: an admitted actor ADDING a reaction to a message the assistant
 * itself authored. That one wakes a discretion turn through the ordinary
 * channel-turn machinery (`buildReactionWakeTurn`); every other reaction
 * stays a passive transcript row and never drives a turn.
 */
import type { SourceMetadata } from "@vellumai/gateway-client";
import {
  type InboundReactionPayload,
  resolveInboundEventKind,
} from "@vellumai/gateway-client";
import { pickReactionEmojiFields } from "@vellumai/service-contracts/reactions";

import type { ChannelId, InterfaceId } from "../../../channels/types.js";
import { createApprovalCopyGenerator } from "../../../daemon/approval-generators.js";
import { findConversation } from "../../../daemon/conversation-registry.js";
import { getDiskPressureStatus } from "../../../daemon/disk-pressure-guard.js";
import { classifyDiskPressureTurnPolicy } from "../../../daemon/disk-pressure-policy.js";
import { processMessage } from "../../../daemon/process-message.js";
import { renderReactionHistoryText } from "../../../daemon/reaction-history-render.js";
import type { TrustContext } from "../../../daemon/trust-context-types.js";
import { writeSlackMetadata } from "../../../messaging/providers/slack/message-metadata.js";
import {
  buildNeutralReactionMeta,
  buildReactionRowEnvelope,
  buildSlackReactionMeta,
} from "../../../messaging/reaction-envelopes.js";
import { readProviderMetadata } from "../../../messaging/read-provider-metadata.js";
import { isGuardianCardRow } from "../../../notifications/approval-card-data.js";
import {
  addMessage,
  getMessageById,
  provenanceFromTrustContext,
} from "../../../persistence/conversation-crud.js";
import {
  findInboundEvent,
  findMessageByProviderMessageId,
  findMessageBySourceId,
  linkMessage,
  recordInbound,
  storePayload,
} from "../../../persistence/delivery-crud.js";
import { markProcessed } from "../../../persistence/delivery-status.js";
import { extractTextFromStoredMessageContent } from "../../../persistence/message-content.js";
import { getLogger } from "../../../util/logger.js";
import { toTrustContext } from "../../actor-trust-resolver.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../assistant-scope.js";
import {
  actorTrustContextFromVerdict,
  verdictUsability,
} from "../../trust-verdict-consumer.js";
import { processChannelMessageInBackground } from "./background-dispatch.js";

const log = getLogger("runtime-http");

/**
 * Whether the inbound payload belongs to the reaction event family, on any
 * channel. Family membership is the kind alone; whether the payload can be
 * acted on is `resolveInboundReactionPayload`'s answer, and the dispatch
 * drops a family member whose payload does not resolve rather than letting
 * it be reinterpreted as a message.
 */
export function isReactionEvent(body: {
  eventKind?: string;
  isEdit?: boolean;
  callbackData?: string;
  callbackQueryId?: string;
}): boolean {
  return resolveInboundEventKind(body) === "reaction";
}

export interface ReactionInterceptParams {
  /** The resolved structured payload: op, emoji, and target message id. */
  reaction: InboundReactionPayload;
  sourceChannel: ChannelId;
  sourceInterface: InterfaceId | undefined;
  conversationExternalId: string;
  externalMessageId: string;
  rawSenderId: string | undefined;
  canonicalSenderId: string | null;
  actorDisplayName: string | undefined;
  actorUsername: string | undefined;
  replyCallbackUrl: string | undefined;
  sourceMetadata: SourceMetadata | undefined;
}

/**
 * Handle a reaction event end to end, on any channel. Always consumes the event (the
 * caller dispatches here only for `isReactionEvent`), returning the
 * response the top-level handler should short-circuit with.
 */
export async function handleReactionIntercept(
  params: ReactionInterceptParams,
): Promise<Record<string, unknown>> {
  const {
    reaction,
    sourceChannel,
    sourceInterface,
    conversationExternalId,
    externalMessageId,
    rawSenderId,
    canonicalSenderId,
    actorDisplayName,
    actorUsername,
    replyCallbackUrl,
    sourceMetadata,
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

  const reactedMessageTs = reaction.targetMessageId;
  // Respect disk-pressure cleanup so reactions don't bypass storage
  // protection. Blocked silently and before any write: a reaction is a
  // passive signal, so the message pipeline's "storage is low, try again"
  // notice is meaningless for an emoji.
  const diskPressure = classifyDiskPressureTurnPolicy(getDiskPressureStatus(), {
    sourceChannel,
    sourceInterface,
    trustContext: {
      sourceChannel,
      trustClass: trustCtx.trustClass,
    },
  });
  if (diskPressure.action === "block") {
    return {
      accepted: true,
      reaction: "dropped_disk_pressure",
      diskPressure: "blocked",
      reason: diskPressure.reason,
    };
  }

  // A redelivery is answered before the reacted message is resolved, so a
  // repeat delivery costs no lookup. `recordInbound` below is the durable
  // dedup; this is the early out in front of it.
  const alreadyRecorded = findInboundEvent(
    sourceChannel,
    conversationExternalId,
    externalMessageId,
  );
  if (alreadyRecorded) {
    return {
      accepted: true,
      duplicate: true,
      eventId: alreadyRecorded.eventId,
    };
  }

  // The reaction belongs to the conversation of the message it was attached
  // to. Slack sends no `thread_ts` on a reaction, so resolving a conversation
  // from the reaction's own address keys one on the reacted message instead of
  // finding the one that message lives in, minting an orphan per reaction.
  // A message the assistant never stored has nothing to annotate, so the
  // reaction is dropped rather than given a conversation of its own.
  // Inbound messages carry their provider id on the event that delivered
  // them. The assistant's own posts open no inbound event, so a reaction on
  // one is resolved through the envelope those rows carry (`slackMeta` on
  // Slack, the neutral `providerMeta` everywhere else).
  const target = reactedMessageTs
    ? (findMessageBySourceId(
        sourceChannel,
        conversationExternalId,
        reactedMessageTs,
      ) ??
      findMessageByProviderMessageId(
        sourceChannel,
        conversationExternalId,
        reactedMessageTs,
      ))
    : null;
  if (!target || !reactedMessageTs) {
    log.debug(
      { sourceChannel, conversationExternalId, reactedMessageTs },
      "Dropping reaction: reacted message is not stored",
    );
    return { accepted: true, reaction: "dropped_unknown_target" };
  }

  // A guardian card is a delivery projection, not conversation content.
  // `isGuardianCardRow` is the predicate both history assemblers already use
  // to keep these rows out of a turn's history; the wake path is the third
  // reader of the same question. A reaction on a card has nothing to
  // annotate, and the card is assistant-authored, so without this it would
  // read as a signal addressed to the assistant and wake a turn. Channel
  // deliveries persist no row today, but ones paired before the
  // projection-only policy are still stored.
  const targetRow = getMessageById(target.messageId, target.conversationId);
  if (isGuardianCardRow(targetRow?.content)) {
    log.debug(
      { sourceChannel, conversationExternalId, reactedMessageTs },
      "Dropping reaction: reacted message is a guardian card",
    );
    return { accepted: true, reaction: "dropped_guardian_card" };
  }

  const result = recordInbound(
    sourceChannel,
    conversationExternalId,
    externalMessageId,
    // No `sourceMessageId`: that column names the provider id of the event's
    // own message, and a reaction is not one. Claiming the reacted message's
    // id here would put two linked rows on that id, leaving a later edit or
    // delete of it free to resolve to the reaction instead.
    { conversationId: target.conversationId },
  );
  if (result.duplicate) {
    return {
      accepted: result.accepted,
      duplicate: true,
      eventId: result.eventId,
    };
  }

  const rowTrustContext = toTrustContext(trustCtx, conversationExternalId);
  const actorExternalId = canonicalSenderId ?? rawSenderId ?? undefined;

  const persistPassively = async (): Promise<void> => {
    await persistReactionAsMessage({
      conversationId: result.conversationId,
      conversationExternalId,
      eventId: result.eventId,
      sourceChannel,
      reaction,
      actorDisplayName,
      actorExternalId,
      reactedMessageTs,
      duplicate: false,
      trustCtx: rowTrustContext,
    });
    // A passive row lands in the store only, so a resident conversation
    // would otherwise carry it only after eviction. Marking it stale makes
    // the next turn's history reload pick the reaction up.
    findConversation(result.conversationId)?.markHistoryStale();
  };

  // An admitted actor ADDING a reaction to the assistant's own message is a
  // signal addressed to the assistant, like a thumbs-up sent to a person: it
  // wakes a discretion turn. Everything else stays a passive transcript
  // row: removals retract rather than address, and a reaction on another
  // participant's message is between-humans signaling. Mechanics on
  // `buildReactionWakeTurn`.
  const wakeTurn =
    reaction.op === "added" && replyCallbackUrl && sourceInterface
      ? buildReactionWakeTurn({
          target,
          targetRow,
          result,
          reaction,
          sourceChannel,
          sourceInterface,
          conversationExternalId,
          replyCallbackUrl,
          actorDisplayName,
          actorExternalId,
          reactedMessageTs,
          trustCtx: rowTrustContext,
          chatType: sourceMetadata?.chatType?.trim() || undefined,
          persistPassively,
        })
      : null;
  if (wakeTurn) {
    try {
      wakeTurn();
      return {
        accepted: result.accepted,
        duplicate: false,
        eventId: result.eventId,
        reaction: "wake_dispatched",
      };
    } catch (err) {
      // Dispatch startup failed before the background turn owns the event
      // (its own failures degrade through `onTurnLostToBusy`). The dedup
      // record already exists, so a gateway retry would short-circuit and
      // leave the reaction unrecorded entirely; fall through to the passive
      // row, which is what this reaction would have been without the wake.
      log.error(
        { err, conversationId: result.conversationId, eventId: result.eventId },
        "Reaction wake dispatch failed to start; recording the passive row",
      );
    }
  }

  try {
    await persistPassively();
  } catch (err) {
    log.error(
      { err, conversationId: result.conversationId, eventId: result.eventId },
      "Failed to persist reaction event",
    );
  }

  return {
    accepted: result.accepted,
    duplicate: result.duplicate,
    eventId: result.eventId,
  };
}

/**
 * Build the dispatch thunk for a reaction-driven discretion turn, or null
 * when the reaction does not qualify: only a reaction on a message the
 * assistant itself authored addresses the assistant.
 *
 * The turn rides `processChannelMessageInBackground` unchanged, so it defers
 * behind an in-flight turn, streams and delivers its reply through the
 * channel rail, and a `<no_response/>` outcome is suppressed everywhere. Its
 * persisted user row carries the same reaction envelope the passive path
 * writes, so the row reads as a reaction to every envelope consumer, and its
 * live content is the same line `renderReactionHistoryText` produces at
 * reload, so the model sees one wording on both paths.
 *
 * Wake turns are at-most-once. The retry sweep's processing lane rebuilds a
 * turn from its stored payload as a plain message, which would corrupt a
 * reaction into a fabricated user message, so the event is marked processed
 * up front and the payload it stores is delivery-only: it names where a
 * generated reply goes and carries no content to rebuild a turn from. A
 * crash mid-turn therefore loses the discretionary turn, never a row the
 * store already held. The one recoverable loss, a non-channel turn stealing
 * the lock after admission, degrades through `persistPassively` to exactly
 * the row the passive path would have written.
 */
function buildReactionWakeTurn(params: {
  target: { messageId: string; conversationId: string };
  targetRow: ReturnType<typeof getMessageById>;
  result: { eventId: string; conversationId: string };
  reaction: InboundReactionPayload;
  sourceChannel: ChannelId;
  sourceInterface: InterfaceId;
  conversationExternalId: string;
  replyCallbackUrl: string;
  actorDisplayName: string | undefined;
  actorExternalId: string | undefined;
  reactedMessageTs: string;
  trustCtx: TrustContext;
  chatType: string | undefined;
  persistPassively: () => Promise<void>;
}): (() => void) | null {
  const targetRow = params.targetRow;
  if (!targetRow || targetRow.role !== "assistant") {
    return null;
  }

  const facts = reactionFacts(params);
  const neutralMeta = buildNeutralReactionMeta(facts);
  const targetText = extractTextFromStoredMessageContent(targetRow.content);
  const content = renderReactionHistoryText(
    neutralMeta,
    () => targetText || undefined,
    { selfAuthored: false },
  );
  if (!content) {
    return null;
  }
  // The reaction envelope rides the same carrier lanes ordinary ingress
  // uses: the neutral `channelInbound` for every non-Slack channel (its
  // lane validates through the canonical schema and passes reaction-kind
  // envelopes verbatim), and the transitional Slack-only field while Slack
  // still writes its own envelope. The passive path keeps
  // `buildReactionRowEnvelope`; the lanes here materialize the same
  // builders' facts, so the two writers still cannot drift.
  const envelopeCarrier =
    params.sourceChannel === "slack"
      ? {
          slackReactionRowMeta: writeSlackMetadata(
            buildSlackReactionMeta(facts),
          ),
        }
      : { channelInbound: neutralMeta };

  const replyCallbackUrl = resolveWakeReplyCallbackUrl(
    params.sourceChannel,
    params.replyCallbackUrl,
    targetRow.metadata,
  );

  return () => {
    // A delivery-only payload: the fields `channel-retry-sweep`'s delivery
    // lane needs to re-post a generated reply whose first delivery failed
    // transiently. It deliberately carries no `content` or `sourceChannel`,
    // so it can never be replayed as a message turn even if this event
    // somehow reached the processing lane; that replay is what the
    // at-most-once design exists to prevent.
    storePayload(params.result.eventId, {
      replyCallbackUrl,
      externalChatId: params.conversationExternalId,
      assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    });
    markProcessed(params.result.eventId);
    processChannelMessageInBackground({
      processMessage,
      conversationId: params.result.conversationId,
      eventId: params.result.eventId,
      content,
      sourceChannel: params.sourceChannel,
      sourceInterface: params.sourceInterface,
      externalChatId: params.conversationExternalId,
      trustCtx: params.trustCtx,
      metadataHints: [],
      replyCallbackUrl,
      assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
      approvalCopyGenerator: createApprovalCopyGenerator(),
      ...(params.chatType ? { chatType: params.chatType } : {}),
      ...envelopeCarrier,
      clientMessageId: `reaction:${params.result.eventId}`,
      skipUserMessageIndexing: true,
      onTurnLostToBusy: params.persistPassively,
    });
  };
}

/**
 * Where a wake turn's reply goes, which is the conversation the reacted
 * message lives in rather than the reaction's own address.
 *
 * A reaction event names no thread of its own, so Slack's normalizer fills
 * the callback's `threadTs` with the REACTED MESSAGE's ts. Delivering
 * through it would root the reply at that message: a thread of its own off
 * a channel post, or an invalid parent when the target is itself a threaded
 * reply. Slack rows record the thread they live in, so the target row's
 * stored `threadId` is the authoritative destination, and its absence means
 * the target sits at the channel root, where the reply belongs too.
 *
 * Every other channel is already correct: a Discord thread IS a channel, so
 * a reaction inside one carries that thread as its address.
 */
function resolveWakeReplyCallbackUrl(
  sourceChannel: ChannelId,
  reactionCallbackUrl: string,
  targetMetadata: string | null,
): string {
  if (sourceChannel !== "slack") {
    return reactionCallbackUrl;
  }
  let url: URL;
  try {
    url = new URL(reactionCallbackUrl);
  } catch {
    return reactionCallbackUrl;
  }
  const targetThreadTs = readProviderMetadata(targetMetadata, {
    allowFlatLegacy: true,
  })?.threadId;
  if (targetThreadTs) {
    url.searchParams.set("threadTs", targetThreadTs);
  } else {
    url.searchParams.delete("threadTs");
  }
  return url.toString();
}

/**
 * Persist a Slack reaction event as a `messages` row with a `slackMeta`
 * envelope so the renderer can surface it inline in the chronological
 * transcript. The row is written and the inbound event is linked; the wake
 * decision is the caller's (`buildReactionWakeTurn`).
 *
 * The caller is expected to have run `recordInbound` already so that
 * deduplication and conversation resolution have happened. Duplicate inbound
 * events are skipped here to keep persistence idempotent.
 */
async function persistReactionAsMessage(params: {
  conversationId: string;
  conversationExternalId: string;
  eventId: string;
  sourceChannel: ChannelId;
  reaction: InboundReactionPayload;
  actorDisplayName?: string;
  /**
   * The reactor's stable channel identity, canonical when resolution
   * succeeded. Persisted as the envelope's actor id: a display name is
   * sender-controlled labeling, and the rendered history line attributes
   * its fenced content by this id (`origin`), never by the label.
   */
  actorExternalId?: string;
  reactedMessageTs: string;
  duplicate: boolean;
  /**
   * The reactor's trust context. Persisted as row provenance so actor-scoped
   * history loads keep the row: `filterMessagesForUntrustedActor` drops any
   * row with no `provenanceTrustClass`, which would hide every reaction from
   * non-guardian turns.
   */
  trustCtx: TrustContext;
}): Promise<void> {
  if (params.duplicate) {
    return;
  }
  const facts = reactionFacts(params);

  // Sentinel content: transcript renderers read the envelope to format the
  // reaction line; the literal text is never displayed to the model.
  const persisted = await addMessage(
    params.conversationId,
    "user",
    "[reaction]",
    {
      metadata: {
        ...provenanceFromTrustContext(params.trustCtx),
        ...buildReactionRowEnvelope(facts),
      },
      skipIndexing: true,
    },
  );
  linkMessage(params.eventId, persisted.id);
  markProcessed(params.eventId);
}

/**
 * The envelope facts of one inbound reaction, from the intercept's own
 * vocabulary. Shared by the passive row and the wake turn's row so the two
 * writers describe the same reaction identically.
 */
function reactionFacts(params: {
  sourceChannel: ChannelId;
  conversationExternalId: string;
  reactedMessageTs: string;
  reaction: InboundReactionPayload;
  actorExternalId?: string;
  actorDisplayName?: string;
}) {
  return {
    channel: params.sourceChannel,
    chatId: params.conversationExternalId,
    targetMessageId: params.reactedMessageTs,
    emoji: params.reaction.emoji,
    ...pickReactionEmojiFields(params.reaction),
    op: params.reaction.op,
    ...(params.actorExternalId
      ? { actorExternalId: params.actorExternalId }
      : {}),
    ...(params.actorDisplayName
      ? { actorDisplayName: params.actorDisplayName }
      : {}),
  };
}
