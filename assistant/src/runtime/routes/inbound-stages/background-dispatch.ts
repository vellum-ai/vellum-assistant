/**
 * Background processing stage: orchestrates fire-and-forget message processing
 * after the synchronous HTTP response has been returned. Manages typing
 * indicators, approval prompt watchers, trusted contact notifications, and
 * the main agent loop invocation.
 *
 * Extracted from inbound-message-handler.ts to keep the top-level handler
 * focused on orchestration.
 */
import type {
  AssistantActivityPhase,
  AssistantEvent,
} from "../../../api/index.js";
import { resolveGuardianPromptDelivery } from "../../../approvals/guardian-channel-delivery.js";
import type { ChannelId, InterfaceId } from "../../../channels/types.js";
import {
  getGuardianDelivery,
  guardianForChannel,
} from "../../../contacts/guardian-delivery-reader.js";
import { isConversationBusyError } from "../../../daemon/conversation-messaging.js";
import type { TrustContext } from "../../../daemon/trust-context-types.js";
import {
  channelActivityRefreshMs,
  setChannelActivity,
  supportsChannelActivity,
} from "../../../messaging/providers/index.js";
import {
  getSiblingStreamedReplyTs,
  linkMessage,
  storeInboundSlackMetadata,
  storeReplyMessageId,
  storeStreamedReplyTs,
} from "../../../persistence/delivery-crud.js";
import {
  deferRetryUntilIdle,
  isDeduplicatedDeliveryOwnedBySibling,
  markProcessed,
  recordProcessingFailure,
} from "../../../persistence/delivery-status.js";
import { resolveGuardianName } from "../../../prompts/user-reference.js";
import { getLogger } from "../../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../assistant-scope.js";
import {
  buildApprovalUIMetadata,
  getApprovalInfoByConversation,
  getChannelApprovalPrompt,
} from "../../channel-approvals.js";
import { deliverChannelReply } from "../../gateway-client.js";
import type {
  ApprovalCopyGenerator,
  MessageProcessor,
  SlackInboundMessageMetadata,
} from "../../http-types.js";
import { hasDeliverableAssistantText } from "../../no-response.js";
import { createSlackReplySession } from "../../slack-reply-session.js";
import { isContactTrustClass } from "../../trust-class.js";
import { resolveRoutingState } from "../../trust-context-resolver.js";
import { finalizeEventDelivery } from "../channel-delivery-routes.js";
import { deliverGeneratedApprovalPrompt } from "../guardian-approval-prompt.js";
import { withChannelTurnAdmission } from "./channel-turn-admission.js";

const log = getLogger("runtime-http");

export function isBoundGuardianActor(params: {
  trustClass: TrustContext["trustClass"];
  guardianExternalUserId?: string;
  requesterExternalUserId?: string;
}): boolean {
  const { trustClass, guardianExternalUserId, requesterExternalUserId } =
    params;

  return (
    trustClass === "guardian" &&
    !!guardianExternalUserId &&
    requesterExternalUserId === guardianExternalUserId
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BackgroundProcessingParams {
  processMessage: MessageProcessor;
  conversationId: string;
  eventId: string;
  content: string;
  displayContent?: string;
  attachmentIds?: string[];
  sourceChannel: ChannelId;
  sourceInterface: InterfaceId;
  externalChatId: string;
  trustCtx: TrustContext;
  metadataHints: string[];
  metadataUxBrief?: string;
  replyCallbackUrl?: string;
  assistantId?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  commandIntent?: Record<string, unknown>;
  sourceLanguageCode?: string;
  /** Chat type from the gateway (e.g. "private", "group", "supergroup"). */
  chatType?: string;
  /** IANA timezone reported by the active client for the current turn. */
  clientTimezone?: string;
  /** Slack app_mention/direct bot mention signal from the gateway. */
  slackBotMentioned?: boolean;
  /**
   * Slack-specific inbound metadata extracted at the HTTP boundary. Threaded
   * through to `persistUserMessage` so the row can be tagged with a
   * `slackMeta` envelope for the chronological renderer.
   */
  slackInbound?: SlackInboundMessageMetadata;
}

/**
 * Fire-and-forget: process the message and deliver the reply in the background.
 * The HTTP response returns immediately so the gateway webhook is not blocked.
 */
export function processChannelMessageInBackground(
  params: BackgroundProcessingParams,
): void {
  const {
    processMessage,
    conversationId,
    eventId,
    content,
    displayContent,
    attachmentIds,
    sourceChannel,
    sourceInterface,
    externalChatId,
    trustCtx,
    metadataHints,
    metadataUxBrief,
    replyCallbackUrl,
    assistantId,
    approvalCopyGenerator,
    commandIntent,
    sourceLanguageCode,
    chatType,
    clientTimezone,
    slackBotMentioned,
    slackInbound,
  } = params;

  // Capture the Slack ingress metadata onto the stored payload up front — before
  // the admission wait or any processing — so if the daemon dies mid-wait or
  // mid-turn, the retry sweep replays with the SAME `slackInbound` this turn
  // used. That keeps the derived idempotency key identical (the replay dedups
  // against a turn this attempt already persisted) and carries full slackMeta.
  if (slackInbound) {
    storeInboundSlackMetadata(eventId, slackInbound);
  }

  // Defer the whole turn + delivery until the conversation's processing lock is
  // free, serialized per conversation so same-conversation replies stay ordered.
  // A channel message routed to a busy conversation (e.g. a Slack
  // thread-participant reply arriving mid-session) is thereby processed when the
  // in-flight turn completes instead of being dropped. See
  // `channel-turn-admission.ts` for why channel turns defer rather than route
  // through the SSE-oriented conversation queue.
  void withChannelTurnAdmission(conversationId, async () => {
    const channelActivity = startChannelActivity({
      replyCallbackUrl,
      conversationId,
      chatId: externalChatId,
      initiatorUserId: slackInbound?.actorExternalUserId,
      startImmediately: shouldShowActivityImmediately({
        chatType,
        botMentioned: slackBotMentioned,
      }),
    });
    const stopApprovalWatcher = replyCallbackUrl
      ? startPendingApprovalPromptWatcher({
          conversationId,
          sourceChannel,
          externalChatId,
          trustClass: trustCtx.trustClass,
          guardianExternalUserId: trustCtx.guardianExternalUserId,
          guardianChatId: trustCtx.guardianChatId,
          requesterExternalUserId: trustCtx.requesterExternalUserId,
          replyCallbackUrl,
          assistantId,
          approvalCopyGenerator,
        })
      : undefined;
    const stopTcApprovalNotifier = replyCallbackUrl
      ? startTrustedContactApprovalNotifier({
          conversationId,
          sourceChannel,
          externalChatId,
          trustClass: trustCtx.trustClass,
          guardianExternalUserId: trustCtx.guardianExternalUserId,
          replyCallbackUrl,
          assistantId,
        })
      : undefined;

    try {
      const cmdIntent =
        commandIntent && typeof commandIntent.type === "string"
          ? {
              type: commandIntent.type as string,
              ...(typeof commandIntent.payload === "string"
                ? { payload: commandIntent.payload }
                : {}),
              ...(sourceLanguageCode
                ? { languageCode: sourceLanguageCode }
                : {}),
            }
          : undefined;
      let replyMessageId: string | undefined;
      const slackReplySession = createSlackReplySession({
        sourceChannel,
        chatType,
        replyCallbackUrl,
        chatId: externalChatId,
        recipientUserId: slackInbound?.actorExternalUserId,
        recipientTeamId: slackInbound?.actorTeamId,
        // Durably record the streamed message `ts` the instant the stream
        // opens, so a crash before `finalizeEventDelivery` leaves a breadcrumb
        // the redelivery path can reuse to edit the reply in place.
        onStreamOpen: (streamTs) => storeStreamedReplyTs(eventId, streamTs),
      });
      const observeAgentEvent = (msg: AssistantEvent): void => {
        if (
          msg.type === "message_complete" &&
          (msg.source === undefined || msg.source === "main") &&
          typeof msg.messageId === "string"
        ) {
          replyMessageId = msg.messageId;
        }
        slackReplySession?.observeEvent(msg);
        channelActivity?.observeEvent(msg);
      };

      let userMessageId: string | undefined;
      let deduplicatedIngress = false;
      try {
        const result = await processMessage(conversationId, content, {
          attachmentIds,
          transport: {
            channelId: sourceChannel,
            hints: metadataHints.length > 0 ? metadataHints : undefined,
            uxBrief: metadataUxBrief,
            chatType,
            ...(clientTimezone ? { clientTimezone } : {}),
          },
          assistantId,
          trustContext: trustCtx,
          isInteractive: resolveRoutingState(trustCtx).promptWaitingAllowed,
          ...(displayContent !== undefined ? { displayContent } : {}),
          ...(cmdIntent ? { commandIntent: cmdIntent } : {}),
          ...(slackInbound ? { slackInbound } : {}),
          onEvent: observeAgentEvent,
          sourceChannel,
          sourceInterface,
        });
        userMessageId = result.messageId;
        deduplicatedIngress = result.deduplicated === true;
        linkMessage(eventId, userMessageId);
        markProcessed(eventId);
        replyMessageId ??= result.assistantMessageId;
        if (replyMessageId) {
          storeReplyMessageId(eventId, replyMessageId);
        }
      } catch (err) {
        // Stop any live Slack stream cleanly. Its `ts` is already durably
        // recorded via `onStreamOpen`, so the retry sweep can reconcile
        // against that message rather than posting a duplicate.
        await slackReplySession?.finish();
        if (isConversationBusyError(err)) {
          // Admission observed the conversation idle, but a non-channel turn
          // (web / wake / voice) re-took the processing lock before this turn
          // could. Re-schedule for the retry sweep without burning a retry
          // attempt (`deferRetryUntilIdle`) so it reprocesses and delivers from
          // the stored payload once the lock frees — a plain processing-failure
          // record would classify the busy message as fatal and dead-letter it
          // (a silent drop), and even a retryable one could exhaust the budget
          // under sustained contention.
          log.info(
            { conversationId, eventId },
            "Channel turn lost the processing lock after admission; deferring to the retry sweep",
          );
          deferRetryUntilIdle(eventId);
          return;
        }
        log.error(
          { err, conversationId },
          "Background channel message processing failed",
        );
        recordProcessingFailure(eventId, err);
        return;
      }

      // An at-least-once redelivery that deduplicated against the original turn
      // must not blindly re-deliver: `finalizeEventDelivery` would re-emit the
      // reply via `sinceMessageId: userMessageId`. Consult the sibling events
      // linked to the same user message (they share `messageId` because the
      // deduped turn returns the original message id and this redelivery was
      // `linkMessage`d to it). `deliveryStatus` goes `pending` → `delivered` |
      // `failed` | `dead_letter`; only `pending` is non-terminal:
      //   - `delivered`            → reply already emitted → skip (would duplicate).
      //   - `failed`/`dead_letter` → a delivery attempt is recorded; the retry
      //     sweep (which selects `deliveryStatus='failed'`) or dead-letter replay
      //     owns recovery → skip to avoid racing it.
      //   - all siblings `pending` → the first process persisted the turn but
      //     died before recording a delivery outcome. The sweep never selects
      //     `pending`, so this redelivery is the only path that can recover the
      //     undelivered reply → fall through and deliver. If that first attempt
      //     had already streamed its reply live into Slack, its message `ts` is
      //     durably recorded on the sibling row (via `onStreamOpen`); reuse it so
      //     recovery edits that visible message in place instead of posting the
      //     persisted reply a second time.
      let priorDeduplicatedDeliveryOwned = false;
      let recoveredStreamMessageTs: string | undefined;
      if (deduplicatedIngress && userMessageId !== undefined) {
        if (isDeduplicatedDeliveryOwnedBySibling(userMessageId, eventId)) {
          priorDeduplicatedDeliveryOwned = true;
        } else {
          recoveredStreamMessageTs = getSiblingStreamedReplyTs(
            userMessageId,
            eventId,
          );
        }
      }

      if (priorDeduplicatedDeliveryOwned) {
        log.info(
          { conversationId, eventId },
          "Skipping channel reply delivery for deduplicated ingress event; a prior attempt owns delivery",
        );
      } else if (replyCallbackUrl) {
        try {
          await finalizeEventDelivery({
            eventId,
            conversationId,
            externalChatId,
            replyCallbackUrl,
            assistantId,
            replyMessageId,
            userMessageId,
            slackReplySession,
            ...(recoveredStreamMessageTs
              ? { priorStreamMessageTs: recoveredStreamMessageTs }
              : {}),
          });
        } catch (err) {
          log.error(
            { err, conversationId },
            "Background channel reply delivery failed",
          );
        }
      }
    } finally {
      channelActivity?.stop();
      stopApprovalWatcher?.();
      stopTcApprovalNotifier?.();
    }
  }).catch((err) => {
    log.error(
      { err, conversationId, eventId },
      "Channel turn admission failed unexpectedly",
    );
  });
}

// ---------------------------------------------------------------------------
// Channel activity indicator
// ---------------------------------------------------------------------------

/**
 * How often the phase is recomputed for a channel whose indicator holds until
 * it is changed. Such a channel is only called when the phase actually moves,
 * so this costs a comparison rather than a request.
 */
const ACTIVITY_PHASE_POLL_MS = 1_000;

type ChannelActivityController = {
  observeEvent: (msg: AssistantEvent) => void;
  stop: () => void;
};

export function shouldShowActivityForText(text: string): boolean {
  return hasDeliverableAssistantText(text);
}

/**
 * Room shapes with one other participant, in each channel's own word for it.
 *
 * SHIM. `chatType` reaches the daemon as whatever the channel called it, so one
 * idea arrives under three spellings and a fourth channel would add a fourth.
 * It belongs normalized at ingress, where each channel already parses its own
 * payload and knows the answer. Until then this is the single place that has to
 * widen for a new channel, and the single place to delete once it does not.
 *
 * Slack's `mpim` is deliberately absent: a group DM has other readers, so it is
 * a room rather than a direct conversation.
 */
const DIRECT_CHAT_TYPES: ReadonlySet<string> = new Set([
  "im", // Slack
  "dm", // Discord
  "private", // Telegram
]);

/**
 * Whether the assistant should show it is working before it has produced any
 * text: it was addressed directly, so a reply is expected either way.
 */
export function shouldShowActivityImmediately(params: {
  chatType?: string;
  botMentioned?: boolean;
}): boolean {
  return (
    (params.chatType !== undefined && DIRECT_CHAT_TYPES.has(params.chatType)) ||
    params.botMentioned === true
  );
}

/**
 * Drive one conversation's activity indicator for the length of a turn.
 *
 * The indicator is held back until the turn is known to be producing a reply,
 * because a channel where the assistant was not addressed may process a
 * message and decide to stay quiet, and an indicator there promises something
 * that is not coming. Being addressed directly is enough on its own.
 *
 * TRANSITIONAL: the phase is derived here from what this dispatch knows, and
 * the daemon already publishes the same lifecycle as `assistant_activity_state`
 * with a monotonic version. That event reaches conversation observers rather
 * than this turn's `onEvent`, so consuming it is its own change; until then
 * this is a second derivation of one lifecycle and should not be extended.
 */
function startChannelActivity(params: {
  replyCallbackUrl?: string;
  conversationId: string;
  chatId: string;
  initiatorUserId?: string;
  startImmediately: boolean;
}): ChannelActivityController | undefined {
  const { replyCallbackUrl, conversationId, chatId, initiatorUserId } = params;
  if (!replyCallbackUrl || !supportsChannelActivity(replyCallbackUrl)) {
    return undefined;
  }
  const url = replyCallbackUrl;

  const refreshMs = channelActivityRefreshMs(url);
  let stopped = false;
  let showing = false;
  let observedAssistantText = "";
  let lastPhase: AssistantActivityPhase | undefined;

  // Serialized so a later phase cannot overtake an earlier one and leave the
  // channel showing a state the turn has already left.
  let pending: Promise<unknown> = Promise.resolve();
  let outstanding = 0;

  const deliver = (phase: AssistantActivityPhase): Promise<boolean> =>
    setChannelActivity(url, {
      chatId,
      phase,
      ...(initiatorUserId ? { initiatorUserId } : {}),
    })
      .then((result) => result.ok)
      .catch((err) => {
        log.debug({ err, chatId, phase }, "Failed to set channel activity");
        return false;
      });

  /**
   * `refresh` is a re-assertion of a phase the channel is already showing, so
   * it is dropped whenever anything is still outstanding. A slow channel would
   * otherwise queue one per tick, and a busy phase that runs after the turn's
   * `idle` raises the indicator again on a turn that has finished.
   *
   * `outstanding` counts sends that are queued or running, not just the one in
   * flight. A flag cannot express two at once: the earlier link's completion
   * would clear it while its successor is still waiting its turn on the chain,
   * and the next tick would queue a third.
   */
  const send = (
    phase: AssistantActivityPhase,
    options?: { refresh?: boolean; retryOnce?: boolean },
  ): void => {
    if (options?.refresh && outstanding > 0) {
      return;
    }
    lastPhase = phase;
    outstanding += 1;
    pending = pending
      .then(async () => {
        const ok = await deliver(phase);
        // A lost terminal transition is not cosmetic: a channel that holds its
        // indicator keeps showing the assistant as working until something
        // else changes it, which on Slack is an hour away.
        if (!ok && options?.retryOnce) {
          await deliver(phase);
        }
      })
      .finally(() => {
        outstanding -= 1;
      });
  };

  const currentPhase = (): AssistantActivityPhase =>
    getApprovalInfoByConversation(conversationId).length > 0
      ? "awaiting_confirmation"
      : "thinking";

  const tick = (): void => {
    if (stopped || !showing) {
      return;
    }
    const phase = currentPhase();
    // A channel whose indicator expires needs the same phase re-asserted; one
    // that holds only needs to hear about a change.
    if (phase !== lastPhase) {
      send(phase);
    } else if (refreshMs !== undefined) {
      send(phase, { refresh: true });
    }
  };

  const interval = setInterval(tick, refreshMs ?? ACTIVITY_PHASE_POLL_MS);
  (interval as { unref?: () => void }).unref?.();

  const show = (): void => {
    if (stopped || showing) {
      return;
    }
    showing = true;
    send(currentPhase());
  };

  if (params.startImmediately) {
    show();
  }

  return {
    observeEvent(msg) {
      if (stopped || showing || msg.type !== "assistant_text_delta") {
        return;
      }
      observedAssistantText += msg.text;
      if (shouldShowActivityForText(observedAssistantText)) {
        show();
      }
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(interval);
      // Only owed when something was shown. `idle` is a real transition on
      // channels that hold the indicator, not a no-op clear.
      if (showing) {
        send("idle", { retryOnce: true });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pending approval prompt watcher
// ---------------------------------------------------------------------------

const PENDING_APPROVAL_POLL_INTERVAL_MS = 300;

function startPendingApprovalPromptWatcher(params: {
  conversationId: string;
  sourceChannel: ChannelId;
  externalChatId: string;
  trustClass: TrustContext["trustClass"];
  guardianExternalUserId?: string;
  guardianChatId?: string;
  requesterExternalUserId?: string;
  replyCallbackUrl: string;
  assistantId?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
}): () => void {
  const {
    conversationId,
    sourceChannel,
    externalChatId,
    trustClass,
    guardianExternalUserId,
    guardianChatId,
    requesterExternalUserId,
    replyCallbackUrl,
    assistantId,
    approvalCopyGenerator,
  } = params;

  // Approval prompt delivery is guardian-only. Non-guardian and unverified
  // actors must never receive approval prompt broadcasts for the conversation.
  // We also require an explicit identity match against the bound guardian to
  // avoid broadcasting prompts when trustClass is stale/mis-scoped.
  if (
    !isBoundGuardianActor({
      trustClass,
      guardianExternalUserId,
      requesterExternalUserId,
    })
  ) {
    return () => {};
  }

  let active = true;
  const deliveredRequestIds = new Set<string>();

  const poll = async (): Promise<void> => {
    while (active) {
      try {
        const prompt = getChannelApprovalPrompt(conversationId);
        const pending = getApprovalInfoByConversation(conversationId);
        const info = pending[0];
        if (prompt && info && !deliveredRequestIds.has(info.requestId)) {
          deliveredRequestIds.add(info.requestId);
          // Addressed to the guardian's own chat, not the chat the turn is
          // running in, which can be a room that reads the tool and its
          // command preview.
          const promptDelivery = resolveGuardianPromptDelivery({
            turnChatId: externalChatId,
            turnCallbackUrl: replyCallbackUrl,
            guardianChatId,
          });
          const delivered = await deliverGeneratedApprovalPrompt({
            replyCallbackUrl: promptDelivery.callbackUrl,
            chatId: promptDelivery.chatId,
            sourceChannel,
            assistantId: assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
            prompt,
            uiMetadata: buildApprovalUIMetadata(prompt, info),
            messageContext: {
              scenario: "standard_prompt",
              toolName: info.toolName,
              channel: sourceChannel,
            },
            approvalCopyGenerator,
          });
          if (!delivered) {
            // Delivery can fail transiently (network or gateway outage).
            // Keep polling and retry prompt delivery for the same request.
            deliveredRequestIds.delete(info.requestId);
          }
        }
      } catch (err) {
        log.warn(
          { err, conversationId },
          "Pending approval prompt watcher failed",
        );
      }
      await delay(PENDING_APPROVAL_POLL_INTERVAL_MS);
    }
  };

  void poll();
  return () => {
    active = false;
  };
}

// ---------------------------------------------------------------------------
// Trusted contact approval notifier
// ---------------------------------------------------------------------------

// Module-level map tracking which approval requestIds have already been
// notified to trusted contacts. Maps requestId -> conversationId so that
// cleanup can be scoped to the owning conversation's poller, preventing
// concurrent pollers from different conversations from evicting each
// other's entries.
const globalNotifiedApprovalRequestIds = new Map<string, string>();

/**
 * Start a poller that sends a one-shot "waiting for guardian approval" message
 * to the trusted/unverified contact when a confirmation_request enters guardian
 * approval wait. Deduplicates by requestId so each request only produces one
 * message.
 *
 * Only activates for trusted_contact and unverified_contact actors with a
 * resolvable guardian route.
 */
function startTrustedContactApprovalNotifier(params: {
  conversationId: string;
  sourceChannel: ChannelId;
  externalChatId: string;
  trustClass: TrustContext["trustClass"];
  guardianExternalUserId?: string;
  replyCallbackUrl: string;
  assistantId?: string;
}): () => void {
  const {
    conversationId,
    sourceChannel,
    externalChatId,
    trustClass,
    guardianExternalUserId,
    replyCallbackUrl,
    assistantId,
  } = params;

  // Only notify identity-known non-guardian contacts (trusted_contact and
  // unverified_contact) who have a resolvable guardian route.
  if (!isContactTrustClass(trustClass) || !guardianExternalUserId) {
    return () => {};
  }

  let active = true;

  const poll = async (): Promise<void> => {
    while (active) {
      try {
        const pending = getApprovalInfoByConversation(conversationId);
        const info = pending[0];

        // Clean up resolved requests from the module-level dedupe map.
        // Only remove entries that belong to THIS conversation — other
        // conversations' pollers own their own entries. Without this
        // scoping, concurrent pollers would evict each other's request
        // IDs and cause duplicate notifications.
        const currentPendingIds = new Set(pending.map((p) => p.requestId));
        for (const [rid, cid] of globalNotifiedApprovalRequestIds) {
          if (cid === conversationId && !currentPendingIds.has(rid)) {
            globalNotifiedApprovalRequestIds.delete(rid);
          }
        }

        if (info && !globalNotifiedApprovalRequestIds.has(info.requestId)) {
          globalNotifiedApprovalRequestIds.set(info.requestId, conversationId);
          // Gateway-resolved guardian display name (display-only).
          const guardians = await getGuardianDelivery({
            channelTypes: [sourceChannel],
          });
          const displayName = guardians
            ? (guardianForChannel(guardians, sourceChannel)?.displayName ??
              undefined)
            : undefined;
          const guardianName = resolveGuardianName(displayName);
          const waitingText = `Waiting for ${guardianName}'s approval...`;
          try {
            await deliverChannelReply(replyCallbackUrl, {
              chatId: externalChatId,
              text: waitingText,
              assistantId: assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
            });
          } catch (err) {
            log.warn(
              { err, conversationId },
              "Failed to deliver trusted-contact pending-approval notification",
            );
            // Remove from notified set so delivery is retried on next poll
            globalNotifiedApprovalRequestIds.delete(info.requestId);
          }
        }
      } catch (err) {
        log.warn(
          { err, conversationId },
          "Trusted-contact approval notifier poll failed",
        );
      }
      await delay(PENDING_APPROVAL_POLL_INTERVAL_MS);
    }
  };

  void poll();
  return () => {
    active = false;

    // Evict all dedupe entries owned by this conversation so the
    // module-level map doesn't grow unboundedly after the poller stops.
    for (const [rid, cid] of globalNotifiedApprovalRequestIds) {
      if (cid === conversationId) {
        globalNotifiedApprovalRequestIds.delete(rid);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
