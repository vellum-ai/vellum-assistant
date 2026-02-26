/**
 * Generic notification conversation pairing.
 *
 * Materializes a conversation + message for each notification delivery
 * before the adapter sends it. This ensures every delivery has an
 * auditable conversation trail and enables the macOS/iOS client to
 * deep-link directly into the notification thread.
 */

import type { ConversationStrategy } from '../channels/config.js';
import { getConversationStrategy } from '../channels/config.js';
import type { ChannelId } from '../channels/types.js';
import { addMessage,createConversation } from '../memory/conversation-store.js';
import { getLogger } from '../util/logger.js';
import type { NotificationSignal } from './signal.js';
import { composeThreadSeed, isThreadSeedSane } from './thread-seed-composer.js';
import type { NotificationChannel } from './types.js';
import type { RenderedChannelCopy } from './types.js';

const log = getLogger('notification-conversation-pairing');

export interface PairingResult {
  conversationId: string | null;
  messageId: string | null;
  strategy: ConversationStrategy;
}

/**
 * Pair a notification delivery with a conversation and seed message.
 *
 * Looks up the channel's conversation strategy from the policy registry
 * and materializes a conversation + assistant message accordingly.
 *
 * Errors are caught and logged — this function never throws so the
 * notification pipeline is not disrupted by pairing failures.
 */
export function pairDeliveryWithConversation(
  signal: NotificationSignal,
  channel: NotificationChannel,
  copy: RenderedChannelCopy,
): PairingResult {
  try {
    const strategy = getConversationStrategy(channel as ChannelId);

    if (strategy === 'not_deliverable') {
      return { conversationId: null, messageId: null, strategy: 'not_deliverable' };
    }

    // For both start_new_conversation and continue_existing_conversation,
    // we create a new conversation per notification delivery for now.
    //
    // True conversation continuation (reusing an existing conversation scoped
    // to channel + assistant via a key like `notif:{assistantId}:{channel}:ongoing`)
    // requires external chat binding lookup which is complex. A future PR will
    // add that capability. For this milestone we materialize conversations and
    // record the intended strategy so the audit trail is complete.
    const title = copy.threadTitle ?? copy.title ?? signal.sourceEventName;

    // Only start_new_conversation threads should be user-visible. For channels
    // that intend to continue an existing external conversation (e.g. Telegram),
    // we still materialize an auditable row but keep it background-only until
    // true continuation-by-key is implemented.
    const threadType = strategy === 'start_new_conversation' ? 'standard' : 'background';

    // Memory indexing is skipped on the seed message below to prevent
    // notification copy from polluting conversational recall.
    const conversation = createConversation({
      title,
      threadType,
      source: 'notification',
    });

    // Prefer model-provided threadSeedMessage when present and sane;
    // fall back to the runtime composer which adapts verbosity to the
    // delivery surface (vellum/macos = richer, telegram = compact).
    const messageContent = isThreadSeedSane(copy.threadSeedMessage)
      ? copy.threadSeedMessage
      : composeThreadSeed(signal, channel, copy);
    // Skip memory indexing — notification audit messages are not conversational
    // memory and should not pollute recall or incur embedding/extraction overhead.
    const message = addMessage(conversation.id, 'assistant', messageContent, undefined, { skipIndexing: true });

    log.info(
      {
        signalId: signal.signalId,
        channel,
        strategy,
        conversationId: conversation.id,
        messageId: message.id,
      },
      'Paired notification delivery with conversation',
    );

    return {
      conversationId: conversation.id,
      messageId: message.id,
      strategy,
    };
  } catch (err) {
    log.error(
      { err, signalId: signal.signalId, channel },
      'Failed to pair notification delivery with conversation — continuing without pairing',
    );
    const fallbackStrategy = (() => {
      try {
        return getConversationStrategy(channel as ChannelId);
      } catch {
        return 'not_deliverable' as const;
      }
    })();
    return { conversationId: null, messageId: null, strategy: fallbackStrategy };
  }
}
