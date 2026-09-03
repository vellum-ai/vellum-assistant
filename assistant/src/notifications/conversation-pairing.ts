/**
 * Generic notification conversation pairing.
 *
 * Pairs a notification delivery with a conversation before the adapter
 * sends it, so the delivery has an auditable conversation trail and the
 * macOS/iOS client can deep-link into it. What is written before the send
 * depends on the channel's strategy:
 *
 * - `start_new_conversation` (vellum): the conversation and its seed
 *   message are materialized here. The send is a local broadcast, and the
 *   feed card's deep link and rewritable row depend on the row existing.
 * - `continue_existing_conversation` (every external channel adapter): only
 *   the chat's home conversation is resolved here, and no row is written.
 *   The broadcaster records the delivered post as an assistant row once the
 *   channel acknowledges it (`recordDeliveredChannelPost`), so a failed or
 *   pending delivery never reads as something the assistant said.
 *
 * Guardian-request deliveries to channels are the exception: they are
 * delivery projections of a canonical request and pair nothing (see the
 * guard below); only their vellum delivery carries a conversation.
 *
 * Resolution order for a channel delivery's home
 * (`resolveChannelDeliveryHome`, `resolveProactiveHomeConversation`):
 * 1. Explicit `reuse_existing` conversation action, when its target exists
 *    with the expected source.
 * 2. The chat's inbound conversation, from its thread-less binding at the
 *    un-prefixed (sourceChannel, externalChatId) key.
 * 3. The chat's `notification:`-namespace conversation.
 * 4. A fresh background conversation, bound under that namespace.
 */

import type { ConversationStrategy } from "../channels/config.js";
import { getConversationStrategy } from "../channels/config.js";
import type { ChannelId } from "../channels/types.js";
import { isAssistantInitiatedThreadsEnabled } from "../config/assistant-initiated-threads-gate.js";
import {
  addMessage,
  createConversation,
  getConversation,
} from "../persistence/conversation-crud.js";
import {
  ASSISTANT_INITIATED_SOURCE,
  type ConversationCreateType,
} from "../persistence/conversation-types.js";
import {
  getBindingByChannelChat,
  upsertOutboundBinding,
} from "../persistence/external-conversation-store.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";
import { getLogger } from "../util/logger.js";
import { withSqliteRetry } from "../util/sqlite-retry.js";
import {
  composeConversationSeed,
  isConversationSeedSane,
} from "./conversation-seed-composer.js";
import { isGuardianRequestSignalEvent } from "./guardian-feed-projection.js";
import type { NotificationSignal } from "./signal.js";
import type {
  ConversationAction,
  DestinationBindingContext,
  NotificationChannel,
} from "./types.js";
import type { RenderedChannelCopy } from "./types.js";

const log = getLogger("notification-conversation-pairing");

/**
 * Prefix applied to sourceChannel values in notification bindings so they
 * occupy a separate namespace from messaging adapter bindings in the
 * external_conversation_bindings table.  Without this, notification pairing
 * and messaging adapters (Telegram, Slack, etc.) would destructively overwrite
 * each other's bindings since both use (sourceChannel, externalChatId) as key.
 */
const NOTIFICATION_CHANNEL_PREFIX = "notification:";
function notificationChannel(sourceChannel: string): string {
  return `${NOTIFICATION_CHANNEL_PREFIX}${sourceChannel}`;
}

export interface PairingResult {
  conversationId: string | null;
  messageId: string | null;
  strategy: ConversationStrategy;
  /** True when a brand-new conversation was created; false when an existing one was reused. */
  createdNewConversation: boolean;
  /** When the model requested reuse_existing but the target was invalid, this is true. */
  conversationFallbackUsed: boolean;
}

export interface PairingOptions {
  /** Per-channel conversation action from the decision engine. */
  conversationAction?: ConversationAction;
  /** Destination binding data for channel-scoped conversation continuation. */
  bindingContext?: DestinationBindingContext;
}

/**
 * Pair a notification delivery with a conversation and seed message.
 *
 * Looks up the channel's conversation strategy from the policy registry.
 * For `continue_existing_conversation` channels it resolves the chat's home
 * conversation and returns a null `messageId` (the row is written after the
 * channel acknowledges the send). For `start_new_conversation` it
 * materializes a conversation and its seed message:
 * 1. `options.conversationAction === "reuse_existing"` reuses the explicit
 *    target when it exists with the expected source.
 * 2. Otherwise a new conversation is created.
 *
 * Invalid/stale targets fall through to the next step.
 *
 * Passive vellum notifications (those without `requiresConversation`) never
 * reach that order. They create nothing, and instead append their body to the
 * producing conversation named by `sourceContextId` when it resolves, since
 * that is the row the home feed's "Go to Conversation" button already targets.
 * The returned `conversationId` is that producing conversation, with
 * `createdNewConversation` false.
 *
 * Errors are caught and logged — this function never throws so the
 * notification pipeline is not disrupted by pairing failures.
 */
/**
 * The event the assistant emits when it has a thought worth the user's time
 * ("assistant.share" - the notifications skill's default), as opposed to a
 * transactional request or a system alert.
 */
const ASSISTANT_SHARE_EVENT = "assistant.share";

/**
 * Promote a background share into an assistant-initiated thread, under the
 * `assistant-initiated-threads` flag.
 *
 * The heartbeat's "have a thought, share it" path emits an assistant.share
 * signal from its own background conversation, and the passive-vellum rule
 * below would append the body there - a row the sidebar never shows. When the
 * section exists, that share is exactly what it is for, so the signal is
 * rewritten to materialize a fresh standard conversation stamped
 * {@link ASSISTANT_INITIATED_SOURCE}, which is the section's membership mark.
 *
 * Deliberately narrow, in every direction it can be:
 * - vellum channel only: other channels deliver the share as a native
 *   message and need no in-app thread;
 * - assistant.share only: transactional events keep their own pairing
 *   rules, and their threads stay out of the section by source;
 * - only when the producing conversation is a background/scheduled run (or
 *   nothing resolvable): a share emitted from inside a user-facing thread
 *   keeps the append, since the user is already looking at that thread;
 * - never over an explicit `conversationMetadata.source` or an existing
 *   `requiresConversation`: a producer that declared its own filing wins.
 *
 * Flag off, the signal passes through untouched and shares keep the passive
 * append: nothing changes for anyone outside the rollout.
 */
function withAssistantInitiatedThread(
  signal: NotificationSignal,
  channel: NotificationChannel,
): NotificationSignal {
  if (
    channel !== "vellum" ||
    signal.sourceEventName !== ASSISTANT_SHARE_EVENT ||
    signal.requiresConversation === true ||
    signal.conversationMetadata?.source !== undefined ||
    !isAssistantInitiatedThreadsEnabled()
  ) {
    return signal;
  }
  const producing = getConversation(signal.sourceContextId);
  if (
    producing &&
    producing.conversationType !== "background" &&
    producing.conversationType !== "scheduled"
  ) {
    return signal;
  }
  return {
    ...signal,
    requiresConversation: true,
    conversationMetadata: {
      ...signal.conversationMetadata,
      source: ASSISTANT_INITIATED_SOURCE,
    },
  };
}

export async function pairDeliveryWithConversation(
  rawSignal: NotificationSignal,
  channel: NotificationChannel,
  copy: RenderedChannelCopy,
  options?: PairingOptions,
): Promise<PairingResult> {
  try {
    const signal = withAssistantInitiatedThread(rawSignal, channel);
    const strategy = getConversationStrategy(channel as ChannelId);

    if (strategy === "not_deliverable" || strategy === "push_only") {
      return {
        conversationId: null,
        messageId: null,
        strategy,
        createdNewConversation: false,
        conversationFallbackUsed: false,
      };
    }

    // A channel-delivered guardian-request approval card (tool
    // approvals, questions, and access requests alike) is a delivery
    // projection of a canonical guardian request, not conversation
    // content: its in-app homes are the home-feed "Needs attention"
    // item and the source conversation's card (the vellum delivery,
    // which still pairs below). Pairing a channel card here would
    // either write it into the guardian's bound chat transcript or
    // mint a fresh conversation for a transient work item, so it gets
    // neither a row nor a conversation. The gateway delivery row (chat
    // id + channel-native message id) remains its only persisted
    // envelope.
    if (
      isGuardianRequestSignalEvent(signal.sourceEventName) &&
      channel !== "vellum"
    ) {
      return {
        conversationId: null,
        messageId: null,
        strategy,
        createdNewConversation: false,
        conversationFallbackUsed: false,
      };
    }

    const conversationAction = options?.conversationAction;
    const bindingContext = options?.bindingContext;

    // Structured content blocks take precedence. They enable Surface-based
    // rendering in the web/macOS/iOS apps (e.g. a card widget instead of
    // plain text). Falls back to model-provided seed or runtime composer.
    const messageContent = copy.seedContentBlocks
      ? JSON.stringify(copy.seedContentBlocks)
      : isConversationSeedSane(copy.conversationSeedMessage)
        ? copy.conversationSeedMessage
        : composeConversationSeed(signal, channel, copy);

    // Passive vellum notifications link back to the originating conversation
    // via `signal.sourceContextId` rather than materializing one of their own.
    // A fresh per-notification conversation just to host the seed message
    // leaves a graveyard entry in the sidebar, so nothing is created here when
    // the producer did not opt in via `requiresConversation`. The decision
    // engine's `reuse_existing` hint is ignored for the same reason: a failed
    // reuse (stale target / source mismatch) falls through to
    // `createConversation`, producing exactly the graveyard entry we want to
    // avoid.
    //
    // The body is still appended to the producing conversation when
    // `sourceContextId` resolves, because every route the user has into this
    // notification ends at that conversation. Tapping the banner deep-links
    // there, and resolves there with or without this append, since the
    // broadcaster falls back to `sourceContextId` for the vellum deep link.
    // The client suppresses the banner outright when that conversation is
    // already on screen, leaving the transcript as the only place the
    // notification can appear. The home feed aims its "Go to Conversation"
    // button at the same row whenever it mirrors the signal.
    //
    // So this is deliberately not gated on home-feed eligibility: a signal the
    // feed declines to mirror still reaches the user through the banner, and
    // this row is what makes that landing honest.
    if (strategy === "start_new_conversation" && !signal.requiresConversation) {
      const appended = await appendBodyToSourceConversation(
        signal,
        channel,
        messageContent,
      );
      return {
        conversationId: appended?.conversationId ?? null,
        messageId: appended?.messageId ?? null,
        strategy,
        createdNewConversation: false,
        conversationFallbackUsed: false,
      };
    }

    const title =
      copy.conversationTitle ?? copy.title ?? signal.sourceEventName;

    // Only start_new_conversation conversations should be user-visible in the sidebar.
    // Channels with continue_existing_conversation reuse bound external conversations
    // and mark them as background so they don't clutter the sidebar UI.
    const conversationType =
      signal.conversationMetadata?.conversationType ??
      (strategy === "start_new_conversation" ? "standard" : "background");
    const source = signal.conversationMetadata?.source ?? "notification";

    // A channel delivery (`continue_existing_conversation`, the strategy of
    // every external channel adapter) resolves the chat's home conversation
    // here and writes no row. The row is written by the broadcaster once the
    // channel acknowledges the post (`recordDeliveredChannelPost`), so a
    // failed or pending delivery never reads as something the assistant said.
    if (strategy === "continue_existing_conversation") {
      const home = await resolveChannelDeliveryHome({
        signal,
        channel,
        conversationAction,
        bindingContext,
        source,
        conversationType,
        title,
      });
      return {
        conversationId: home.conversationId,
        messageId: null,
        strategy,
        createdNewConversation: home.createdNewConversation,
        conversationFallbackUsed: home.conversationFallbackUsed,
      };
    }

    // Attempt to reuse an existing conversation when the model requests it
    if (conversationAction?.action === "reuse_existing") {
      const targetId = conversationAction.conversationId;
      const existing = getConversation(targetId);

      const effectiveSource =
        signal.conversationMetadata?.source ?? "notification";
      if (existing && existing.source === effectiveSource) {
        // Append the seed message to the existing conversation
        const message = await addMessage(
          existing.id,
          "assistant",
          messageContent,
          { skipIndexing: true },
        );

        // Rebind the destination so subsequent deliveries to the same
        // (sourceChannel, externalChatId) resolve to this conversation.
        if (bindingContext?.sourceChannel && bindingContext?.externalChatId) {
          upsertOutboundBinding({
            conversationId: existing.id,
            sourceChannel: notificationChannel(bindingContext.sourceChannel),
            externalChatId: bindingContext.externalChatId,
          });
        }

        log.info(
          {
            signalId: signal.signalId,
            channel,
            strategy,
            conversationId: existing.id,
            messageId: message.id,
            conversationAction: "reuse_existing",
          },
          "Reused existing notification conversation for delivery",
        );

        return {
          conversationId: existing.id,
          messageId: message.id,
          strategy,
          createdNewConversation: false,
          conversationFallbackUsed: false,
        };
      }

      // Target is invalid/stale — fall back to creating a new conversation
      log.warn(
        {
          signalId: signal.signalId,
          channel,
          targetConversationId: targetId,
          targetExists: !!existing,
          targetSource: existing?.source,
        },
        "Conversation reuse target invalid — falling back to new conversation",
      );

      const conversation = await withSqliteRetry(
        () =>
          createConversation({
            title,
            conversationType,
            source: signal.conversationMetadata?.source ?? "notification",
            groupId: signal.conversationMetadata?.groupId,
            scheduleJobId: signal.conversationMetadata?.scheduleJobId,
          }),
        { op: "conversationPairing.reuseFallback" },
      );

      const message = await addMessage(
        conversation.id,
        "assistant",
        messageContent,
        { skipIndexing: true },
      );

      // Bind the new conversation to the destination so subsequent
      // deliveries reuse it instead of creating yet another conversation.
      if (bindingContext?.sourceChannel && bindingContext?.externalChatId) {
        upsertOutboundBinding({
          conversationId: conversation.id,
          sourceChannel: notificationChannel(bindingContext.sourceChannel),
          externalChatId: bindingContext.externalChatId,
        });
      }

      return {
        conversationId: conversation.id,
        messageId: message.id,
        strategy,
        createdNewConversation: true,
        conversationFallbackUsed: true,
      };
    }

    // Default path: create a new conversation
    // Memory indexing is skipped on the seed message below to prevent
    // notification copy from polluting conversational recall.
    const conversation = await withSqliteRetry(
      () =>
        createConversation({
          title,
          conversationType,
          source: signal.conversationMetadata?.source ?? "notification",
          groupId: signal.conversationMetadata?.groupId,
          scheduleJobId: signal.conversationMetadata?.scheduleJobId,
        }),
      { op: "conversationPairing.default" },
    );

    // Skip memory indexing — notification audit messages are not conversational
    // memory and should not pollute recall or incur embedding/extraction overhead.
    const message = await addMessage(
      conversation.id,
      "assistant",
      messageContent,
      { skipIndexing: true },
    );

    // When binding context is available, record the new conversation so
    // subsequent deliveries to the same destination reuse it.
    if (bindingContext?.sourceChannel && bindingContext?.externalChatId) {
      upsertOutboundBinding({
        conversationId: conversation.id,
        sourceChannel: notificationChannel(bindingContext.sourceChannel),
        externalChatId: bindingContext.externalChatId,
      });
    }

    log.info(
      {
        signalId: signal.signalId,
        channel,
        strategy,
        conversationId: conversation.id,
        messageId: message.id,
        conversationAction: conversationAction?.action ?? "start_new",
      },
      "Paired notification delivery with conversation",
    );

    return {
      conversationId: conversation.id,
      messageId: message.id,
      strategy,
      createdNewConversation: true,
      conversationFallbackUsed: false,
    };
  } catch (err) {
    log.error(
      { err, signalId: rawSignal.signalId, channel },
      "Failed to pair notification delivery with conversation — continuing without pairing",
    );
    const fallbackStrategy = (() => {
      try {
        return getConversationStrategy(channel as ChannelId);
      } catch {
        return "not_deliverable" as const;
      }
    })();
    return {
      conversationId: null,
      messageId: null,
      strategy: fallbackStrategy,
      createdNewConversation: false,
      conversationFallbackUsed: false,
    };
  }
}

/**
 * Where a chat's proactive posts live: the conversation a delivery to
 * (`sourceChannel`, `externalChatId`) is recorded in once the channel
 * acknowledges it.
 *
 * Resolution order:
 * 1. The chat's inbound conversation, when the person has messaged in this
 *    chat and the inbound pipeline bound it at the un-prefixed key. Posting
 *    there keeps the notification in the history the person's replies land
 *    in. The source check is skipped on purpose: that conversation's source
 *    is not `notification`, and it is still the right home. The lookup is
 *    for the chat's thread-less binding, so a thread-scoped chat (a Slack
 *    agent DM, a Telegram topic), whose inbound bindings each carry a thread
 *    id, never resolves here and falls through to its own proactive home
 *    rather than into one of its threads.
 * 2. The chat's `notification:`-namespace conversation, when one exists with
 *    the expected source. Its binding is touched so it stays fresh.
 * 3. A new background conversation, bound under the `notification:`
 *    namespace so later deliveries reuse it.
 *
 * Resolves only; writes no message row. Shared by notification pairing and
 * by the messaging tool's cross-post, which record their delivered posts
 * after the provider acknowledges them.
 */
export async function resolveProactiveHomeConversation(params: {
  sourceChannel: string;
  externalChatId: string;
  /** Source stamped on a conversation this creates, and required of a reused one. */
  source: string;
  conversationType: ConversationCreateType;
  title: string;
  groupId?: string;
  scheduleJobId?: string;
}): Promise<{ conversationId: string; createdNewConversation: boolean }> {
  const { sourceChannel, externalChatId } = params;

  const inboundBinding = getBindingByChannelChat(sourceChannel, externalChatId);
  if (inboundBinding) {
    const inboundConversation = getConversation(inboundBinding.conversationId);
    if (inboundConversation) {
      return {
        conversationId: inboundConversation.id,
        createdNewConversation: false,
      };
    }
  }

  const notificationBinding = getBindingByChannelChat(
    notificationChannel(sourceChannel),
    externalChatId,
  );
  if (notificationBinding) {
    const boundConversation = getConversation(
      notificationBinding.conversationId,
    );
    if (boundConversation && boundConversation.source === params.source) {
      upsertOutboundBinding({
        conversationId: boundConversation.id,
        sourceChannel: notificationChannel(sourceChannel),
        externalChatId,
      });
      return {
        conversationId: boundConversation.id,
        createdNewConversation: false,
      };
    }
    log.warn(
      {
        sourceChannel,
        externalChatId,
        boundConversationId: notificationBinding.conversationId,
        boundConversationExists: !!boundConversation,
        boundConversationSource: boundConversation?.source,
      },
      "Bound notification conversation stale or invalid: creating a fresh conversation",
    );
  }

  const conversation = await withSqliteRetry(
    () =>
      createConversation({
        title: params.title,
        conversationType: params.conversationType,
        source: params.source,
        groupId: params.groupId,
        scheduleJobId: params.scheduleJobId,
      }),
    { op: "conversationPairing.proactiveHome" },
  );
  upsertOutboundBinding({
    conversationId: conversation.id,
    sourceChannel: notificationChannel(sourceChannel),
    externalChatId,
  });
  return { conversationId: conversation.id, createdNewConversation: true };
}

/**
 * Resolve the home conversation for a channel delivery before it is sent.
 *
 * An explicit `reuse_existing` action from the decision engine takes
 * precedence when its target exists with the expected source (and the
 * destination is rebound to it); otherwise the chat's proactive home
 * (`resolveProactiveHomeConversation`). A delivery with no binding context
 * has no chat to key on and gets a fresh background conversation.
 */
async function resolveChannelDeliveryHome(params: {
  signal: NotificationSignal;
  channel: NotificationChannel;
  conversationAction: ConversationAction | undefined;
  bindingContext: DestinationBindingContext | undefined;
  source: string;
  conversationType: ConversationCreateType;
  title: string;
}): Promise<{
  conversationId: string;
  createdNewConversation: boolean;
  conversationFallbackUsed: boolean;
}> {
  const { signal, channel, conversationAction, bindingContext } = params;
  const metadata = signal.conversationMetadata;
  let conversationFallbackUsed = false;

  if (conversationAction?.action === "reuse_existing") {
    const targetId = conversationAction.conversationId;
    const existing = getConversation(targetId);
    if (existing && existing.source === params.source) {
      if (bindingContext?.sourceChannel && bindingContext?.externalChatId) {
        upsertOutboundBinding({
          conversationId: existing.id,
          sourceChannel: notificationChannel(bindingContext.sourceChannel),
          externalChatId: bindingContext.externalChatId,
        });
      }
      log.info(
        {
          signalId: signal.signalId,
          channel,
          conversationId: existing.id,
          conversationAction: "reuse_existing",
        },
        "Reused existing notification conversation as the delivery's home",
      );
      return {
        conversationId: existing.id,
        createdNewConversation: false,
        conversationFallbackUsed: false,
      };
    }
    log.warn(
      {
        signalId: signal.signalId,
        channel,
        targetConversationId: targetId,
        targetExists: !!existing,
        targetSource: existing?.source,
      },
      "Conversation reuse target invalid: resolving the chat's home instead",
    );
    conversationFallbackUsed = true;
  }

  if (bindingContext?.sourceChannel && bindingContext?.externalChatId) {
    const home = await resolveProactiveHomeConversation({
      sourceChannel: bindingContext.sourceChannel,
      externalChatId: bindingContext.externalChatId,
      source: params.source,
      conversationType: params.conversationType,
      title: params.title,
      groupId: metadata?.groupId,
      scheduleJobId: metadata?.scheduleJobId,
    });
    log.info(
      {
        signalId: signal.signalId,
        channel,
        conversationId: home.conversationId,
        createdNewConversation: home.createdNewConversation,
        bindingKey: `${bindingContext.sourceChannel}:${bindingContext.externalChatId}`,
      },
      "Resolved the chat's home conversation for a channel delivery",
    );
    return { ...home, conversationFallbackUsed };
  }

  const conversation = await withSqliteRetry(
    () =>
      createConversation({
        title: params.title,
        conversationType: params.conversationType,
        source: params.source,
        groupId: metadata?.groupId,
        scheduleJobId: metadata?.scheduleJobId,
      }),
    { op: "conversationPairing.channelHomeUnbound" },
  );
  return {
    conversationId: conversation.id,
    createdNewConversation: true,
    conversationFallbackUsed,
  };
}

/**
 * Append a delivered notification body to the conversation that produced it.
 *
 * Passive notifications never materialize a conversation of their own, so the
 * home feed points "Go to Conversation" at the producing conversation
 * (`resolveHomeFeedMirror` prefers `sourceContextId`). Writing the body there
 * makes that button truthful: whenever it renders, the conversation it opens
 * contains the notification the user tapped.
 *
 * Reuse only. Producers may pass sentinels (job ids, call session ids,
 * `access-req-*` strings) as `sourceContextId`; those resolve to nothing and
 * append nothing, which matches the button staying hidden for them.
 *
 * This covers vellum deliveries only, since no other channel takes the
 * passive branch. A signal routed away from vellum still gets a card, so
 * `writeHomeFeedItemForSignal` writes the body itself when no vellum
 * conversation was paired. Between them the button holds whatever the
 * routing was, and only one of the two ever writes.
 *
 * Indexing is skipped for parity with the other notification write paths:
 * notification copy is delivery audit, not conversational memory.
 */
async function appendBodyToSourceConversation(
  signal: NotificationSignal,
  channel: NotificationChannel,
  messageContent: string,
): Promise<{ conversationId: string; messageId: string } | null> {
  const sourceContextId = signal.sourceContextId;
  if (!sourceContextId) {
    return null;
  }

  let existing: ReturnType<typeof getConversation>;
  try {
    existing = getConversation(sourceContextId);
  } catch {
    return null;
  }
  if (!existing) {
    return null;
  }

  const message = await addMessage(existing.id, "assistant", messageContent, {
    skipIndexing: true,
  });
  // `addMessage` projects attention metadata alone, so a client with this
  // conversation open needs the messages tag to refetch the transcript. A
  // notification the user taps through to has every chance of landing on an
  // already-open conversation.
  publishConversationMessagesChanged(existing.id);

  log.info(
    {
      signalId: signal.signalId,
      channel,
      conversationId: existing.id,
      messageId: message.id,
    },
    "Appended notification body to producing conversation",
  );

  return { conversationId: existing.id, messageId: message.id };
}
