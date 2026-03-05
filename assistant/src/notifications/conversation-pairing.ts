/**
 * Generic notification conversation pairing.
 *
 * Materializes a conversation + message for each notification delivery
 * before the adapter sends it. This ensures every delivery has an
 * auditable conversation trail and enables the macOS/iOS client to
 * deep-link directly into the notification thread.
 *
 * When the decision engine selects `reuse_existing` for a channel and
 * the target conversation is valid, the seed message is appended to the
 * existing thread instead of creating a new one.
 */

import type { ConversationStrategy } from "../channels/config.js";
import { getConversationStrategy } from "../channels/config.js";
import type { ChannelId } from "../channels/types.js";
import {
  addMessage,
  createConversation,
  getConversation,
} from "../memory/conversation-store.js";
import { getLogger } from "../util/logger.js";
import type { NotificationSignal } from "./signal.js";
import { composeThreadSeed, isThreadSeedSane } from "./thread-seed-composer.js";
import type {
  DestinationBindingContext,
  NotificationChannel,
  ThreadAction,
} from "./types.js";
import type { RenderedChannelCopy } from "./types.js";

const log = getLogger("notification-conversation-pairing");

export interface PairingResult {
  conversationId: string | null;
  messageId: string | null;
  strategy: ConversationStrategy;
  /** True when a brand-new conversation was created; false when an existing one was reused. */
  createdNewConversation: boolean;
  /** When the model requested reuse_existing but the target was invalid, this is true. */
  threadDecisionFallbackUsed: boolean;
}

export interface PairingOptions {
  /** Per-channel thread action from the decision engine. */
  threadAction?: ThreadAction;
  /** Destination binding data for channel-scoped conversation continuation. */
  bindingContext?: DestinationBindingContext;
}

/**
 * Pair a notification delivery with a conversation and seed message.
 *
 * Looks up the channel's conversation strategy from the policy registry
 * and materializes a conversation + assistant message accordingly.
 *
 * When `options.threadAction` is `reuse_existing`, the function attempts
 * to look up the target conversation. If it exists and has the right source,
 * the seed message is appended to it. If the target is invalid or stale,
 * a new conversation is created instead (with `threadDecisionFallbackUsed`
 * set to true on the result).
 *
 * Errors are caught and logged — this function never throws so the
 * notification pipeline is not disrupted by pairing failures.
 */
export async function pairDeliveryWithConversation(
  signal: NotificationSignal,
  channel: NotificationChannel,
  copy: RenderedChannelCopy,
  options?: PairingOptions,
): Promise<PairingResult> {
  try {
    const strategy = getConversationStrategy(channel as ChannelId);

    if (strategy === "not_deliverable") {
      return {
        conversationId: null,
        messageId: null,
        strategy: "not_deliverable",
        createdNewConversation: false,
        threadDecisionFallbackUsed: false,
      };
    }

    const title = copy.threadTitle ?? copy.title ?? signal.sourceEventName;

    // Only start_new_conversation threads should be user-visible. For channels
    // that intend to continue an existing external conversation (e.g. Telegram),
    // we still materialize an auditable row but keep it background-only until
    // true continuation-by-key is implemented.
    const threadType =
      strategy === "start_new_conversation" ? "standard" : "background";

    // Prefer model-provided threadSeedMessage when present and sane;
    // fall back to the runtime composer which adapts verbosity to the
    // delivery surface (vellum/macos = richer, telegram = compact).
    const messageContent = isThreadSeedSane(copy.threadSeedMessage)
      ? copy.threadSeedMessage
      : composeThreadSeed(signal, channel, copy);

    const threadAction = options?.threadAction;

    // Attempt to reuse an existing conversation when the model requests it
    if (threadAction?.action === "reuse_existing") {
      const targetId = threadAction.conversationId;
      const existing = getConversation(targetId);

      if (existing && existing.source === "notification") {
        // Append the seed message to the existing conversation thread
        const message = await addMessage(
          existing.id,
          "assistant",
          messageContent,
          undefined,
          { skipIndexing: true },
        );

        log.info(
          {
            signalId: signal.signalId,
            channel,
            strategy,
            conversationId: existing.id,
            messageId: message.id,
            threadAction: "reuse_existing",
          },
          "Reused existing notification conversation for delivery",
        );

        return {
          conversationId: existing.id,
          messageId: message.id,
          strategy,
          createdNewConversation: false,
          threadDecisionFallbackUsed: false,
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
        "Thread reuse target invalid — falling back to new conversation",
      );

      const conversation = createConversation({
        title,
        threadType,
        source: "notification",
      });

      const message = await addMessage(
        conversation.id,
        "assistant",
        messageContent,
        undefined,
        { skipIndexing: true },
      );

      return {
        conversationId: conversation.id,
        messageId: message.id,
        strategy,
        createdNewConversation: true,
        threadDecisionFallbackUsed: true,
      };
    }

    // Default path: create a new conversation
    // Memory indexing is skipped on the seed message below to prevent
    // notification copy from polluting conversational recall.
    const conversation = createConversation({
      title,
      threadType,
      source: "notification",
    });

    // Skip memory indexing — notification audit messages are not conversational
    // memory and should not pollute recall or incur embedding/extraction overhead.
    const message = await addMessage(
      conversation.id,
      "assistant",
      messageContent,
      undefined,
      { skipIndexing: true },
    );

    log.info(
      {
        signalId: signal.signalId,
        channel,
        strategy,
        conversationId: conversation.id,
        messageId: message.id,
        threadAction: threadAction?.action ?? "start_new",
      },
      "Paired notification delivery with conversation",
    );

    return {
      conversationId: conversation.id,
      messageId: message.id,
      strategy,
      createdNewConversation: true,
      threadDecisionFallbackUsed: false,
    };
  } catch (err) {
    log.error(
      { err, signalId: signal.signalId, channel },
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
      threadDecisionFallbackUsed: false,
    };
  }
}
