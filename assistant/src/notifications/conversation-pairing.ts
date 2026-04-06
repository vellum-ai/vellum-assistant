/**
 * Generic notification conversation pairing.
 *
 * Materializes a conversation + message for each notification delivery
 * before the adapter sends it. This ensures every delivery has an
 * auditable conversation trail and enables the macOS/iOS client to
 * deep-link directly into the notification conversation.
 *
 * Resolution order:
 * 1. Explicit `reuse_existing` conversation action — highest precedence.
 * 2. Binding-key reuse — for `continue_existing_conversation` channels,
 *    looks up a previously bound conversation by (sourceChannel, externalChatId).
 * 3. Default — creates a fresh conversation and, when binding context is
 *    present, upserts it into the external-conversation store for future reuse.
 */

import type { ConversationStrategy } from "../channels/config.js";
import { getConversationStrategy } from "../channels/config.js";
import type { ChannelId } from "../channels/types.js";
import {
  addMessage,
  createConversation,
  getConversation,
} from "../memory/conversation-crud.js";
import {
  getBindingByChannelChat,
  upsertOutboundBinding,
} from "../memory/external-conversation-store.js";
import { getLogger } from "../util/logger.js";
import {
  composeConversationSeed,
  isConversationSeedSane,
} from "./conversation-seed-composer.js";
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
 * Looks up the channel's conversation strategy from the policy registry
 * and materializes a conversation + assistant message accordingly.
 *
 * Resolution precedence:
 * 1. `options.conversationAction === "reuse_existing"` — reuse the explicit target.
 * 2. `continue_existing_conversation` strategy with binding context —
 *    look up a previously bound conversation by (sourceChannel, externalChatId).
 * 3. Create a new conversation (and upsert the binding when context is present).
 *
 * Invalid/stale targets at any level fall through to the next.
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
        conversationFallbackUsed: false,
      };
    }

    const title =
      copy.conversationTitle ?? copy.title ?? signal.sourceEventName;

    // Only start_new_conversation conversations should be user-visible in the sidebar.
    // Channels with continue_existing_conversation reuse bound external conversations
    // and mark them as background so they don't clutter the sidebar UI.
    const conversationType =
      strategy === "start_new_conversation" ? "standard" : "background";

    // Prefer model-provided conversationSeedMessage when present and sane;
    // fall back to the runtime composer which adapts verbosity to the
    // delivery surface (vellum/macos = richer, telegram = compact).
    const messageContent = isConversationSeedSane(copy.conversationSeedMessage)
      ? copy.conversationSeedMessage
      : composeConversationSeed(signal, channel, copy);

    const conversationAction = options?.conversationAction;
    const bindingContext = options?.bindingContext;

    // Attempt to reuse an existing conversation when the model requests it
    if (conversationAction?.action === "reuse_existing") {
      const targetId = conversationAction.conversationId;
      const existing = getConversation(targetId);

      if (existing && existing.source === "notification") {
        // Append the seed message to the existing conversation
        const message = await addMessage(
          existing.id,
          "assistant",
          messageContent,
          undefined,
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

      const conversation = createConversation({
        title,
        conversationType,
        source: signal.conversationMetadata?.source ?? "notification",
        groupId: signal.conversationMetadata?.groupId,
        scheduleJobId: signal.conversationMetadata?.scheduleJobId,
      });

      const message = await addMessage(
        conversation.id,
        "assistant",
        messageContent,
        undefined,
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

    // For channels with continue_existing_conversation strategy, try to
    // reuse a previously bound conversation keyed by (sourceChannel, externalChatId)
    // before falling through to create a new one.
    if (
      strategy === "continue_existing_conversation" &&
      bindingContext?.sourceChannel &&
      bindingContext?.externalChatId
    ) {
      // Look up by namespaced key first; fall back to pre-namespace key for
      // bindings created before the notification: prefix was introduced.
      const existingBinding =
        getBindingByChannelChat(
          notificationChannel(bindingContext.sourceChannel),
          bindingContext.externalChatId,
        ) ??
        getBindingByChannelChat(
          bindingContext.sourceChannel,
          bindingContext.externalChatId,
        );

      if (existingBinding) {
        const boundConversation = getConversation(
          existingBinding.conversationId,
        );

        if (boundConversation && boundConversation.source === "notification") {
          const message = await addMessage(
            boundConversation.id,
            "assistant",
            messageContent,
            undefined,
            { skipIndexing: true },
          );

          // Touch the outbound timestamp so the binding stays fresh.
          upsertOutboundBinding({
            conversationId: boundConversation.id,
            sourceChannel: notificationChannel(bindingContext.sourceChannel),
            externalChatId: bindingContext.externalChatId,
          });

          log.info(
            {
              signalId: signal.signalId,
              channel,
              strategy,
              conversationId: boundConversation.id,
              messageId: message.id,
              bindingKey: `${bindingContext.sourceChannel}:${bindingContext.externalChatId}`,
            },
            "Reused bound conversation for channel destination",
          );

          return {
            conversationId: boundConversation.id,
            messageId: message.id,
            strategy,
            createdNewConversation: false,
            conversationFallbackUsed: false,
          };
        }

        // Binding exists but conversation is stale or wrong source — fall through
        // to create a new one and re-bind below.
        log.warn(
          {
            signalId: signal.signalId,
            channel,
            boundConversationId: existingBinding.conversationId,
            boundConversationExists: !!boundConversation,
            boundConversationSource: boundConversation?.source,
          },
          "Bound conversation stale or invalid — creating fresh conversation",
        );
      }
    }

    // Default path: create a new conversation
    // Memory indexing is skipped on the seed message below to prevent
    // notification copy from polluting conversational recall.
    const conversation = createConversation({
      title,
      conversationType,
      source: signal.conversationMetadata?.source ?? "notification",
      groupId: signal.conversationMetadata?.groupId,
      scheduleJobId: signal.conversationMetadata?.scheduleJobId,
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
      conversationFallbackUsed: false,
    };
  }
}
