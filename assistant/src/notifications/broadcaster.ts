/**
 * NotificationBroadcaster -- dispatches a notification decision to all
 * selected channels through their respective adapters.
 *
 * For each channel in the decision's selectedChannels:
 *   1. Resolves the destination via the destination-resolver
 *   2. Pulls rendered copy from the decision (or falls back to copy-composer)
 *   3. Dispatches through the channel adapter
 *   4. Records a delivery audit row in the deliveries-store
 */

import { v4 as uuid } from 'uuid';
import { getLogger } from '../util/logger.js';
import { composeFallbackCopy } from './copy-composer.js';
import { pairDeliveryWithConversation } from './conversation-pairing.js';
import { resolveDestinations } from './destination-resolver.js';
import { createDelivery, updateDeliveryStatus } from './deliveries-store.js';
import type { NotificationSignal } from './signal.js';
import type {
  NotificationChannel,
  NotificationDecision,
  NotificationDeliveryResult,
  ChannelAdapter,
  ChannelDeliveryPayload,
  RenderedChannelCopy,
} from './types.js';

const log = getLogger('notif-broadcaster');

/** Callback invoked immediately when a vellum notification thread is created. */
export interface ThreadCreatedInfo {
  conversationId: string;
  title: string;
  sourceEventName: string;
}
export type OnThreadCreatedFn = (info: ThreadCreatedInfo) => void;

export class NotificationBroadcaster {
  private adapters: Map<NotificationChannel, ChannelAdapter>;
  private onThreadCreated: OnThreadCreatedFn | null = null;

  constructor(adapters: ChannelAdapter[]) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      this.adapters.set(adapter.channel, adapter);
    }
  }

  /** Register a callback that fires immediately when a vellum conversation is paired. */
  setOnThreadCreated(fn: OnThreadCreatedFn): void {
    this.onThreadCreated = fn;
  }

  /**
   * Broadcast a notification decision to all selected channels.
   *
   * The decision carries rendered copy per channel. When the decision was
   * produced by the fallback path (fallbackUsed === true) and is missing
   * copy for a channel, the copy-composer generates deterministic fallback copy.
   *
   * Returns an array of delivery results -- one per channel attempted.
   */
  async broadcastDecision(
    signal: NotificationSignal,
    decision: NotificationDecision,
  ): Promise<NotificationDeliveryResult[]> {
    const destinations = resolveDestinations(signal.assistantId, decision.selectedChannels);

    // Ensure vellum is processed first so the notification_thread_created IPC
    // push fires immediately, before slower channel sends (e.g. Telegram 30s
    // timeout) can delay it past the macOS deep-link retry window.
    const orderedChannels = [...decision.selectedChannels].sort((a, b) => {
      if (a === 'vellum') return -1;
      if (b === 'vellum') return 1;
      return 0;
    });

    // Pre-compute fallback copy in case any channel is missing rendered copy
    let fallbackCopy: Partial<Record<NotificationChannel, RenderedChannelCopy>> | null = null;

    const results: NotificationDeliveryResult[] = [];

    for (const channel of orderedChannels) {
      const adapter = this.adapters.get(channel);
      if (!adapter) {
        log.warn({ channel, signalId: signal.signalId }, 'No adapter registered for channel -- skipping');
        results.push({
          channel,
          destination: '',
          status: 'skipped',
          errorMessage: `No adapter for channel: ${channel}`,
        });
        continue;
      }

      const destination = destinations.get(channel);
      if (!destination) {
        log.warn({ channel, signalId: signal.signalId }, 'Could not resolve destination -- skipping');
        results.push({
          channel,
          destination: '',
          status: 'skipped',
          errorMessage: `Destination not resolved for channel: ${channel}`,
        });
        continue;
      }

      // Pull rendered copy from the decision; fall back to copy-composer if missing
      let copy = decision.renderedCopy[channel];
      if (!copy) {
        if (!fallbackCopy) {
          fallbackCopy = composeFallbackCopy(signal, decision.selectedChannels);
        }
        copy = fallbackCopy[channel] ?? { title: 'Notification', body: signal.sourceEventName };
      }

      // Pair the delivery with a conversation before sending
      const pairing = pairDeliveryWithConversation(signal, channel, copy);

      // For the vellum channel, merge the conversationId into deep-link metadata
      // so the macOS/iOS client can navigate directly to the notification thread.
      let deepLinkTarget = decision.deepLinkTarget;
      if (channel === 'vellum' && pairing.conversationId) {
        deepLinkTarget = { ...deepLinkTarget, conversationId: pairing.conversationId };

        // Emit notification_thread_created immediately when the vellum
        // conversation is paired, BEFORE waiting for adapter send or other
        // channel deliveries. This avoids a race where slow Telegram delivery
        // delays the IPC push past the macOS deep-link retry window.
        if (pairing.strategy === 'start_new_conversation' && this.onThreadCreated) {
          const threadTitle =
            copy.threadTitle ??
            copy.title ??
            signal.sourceEventName;
          try {
            this.onThreadCreated({
              conversationId: pairing.conversationId,
              title: threadTitle,
              sourceEventName: signal.sourceEventName,
            });
          } catch (err) {
            log.error({ err, signalId: signal.signalId }, 'onThreadCreated callback failed — continuing broadcast');
          }
        }
      }

      const payload: ChannelDeliveryPayload = {
        sourceEventName: signal.sourceEventName,
        copy,
        deepLinkTarget,
      };

      const deliveryId = uuid();
      const destinationLabel = destination.endpoint ?? channel;

      // Only create a delivery audit record when we have a persisted decision ID
      // for the FK. If decision persistence failed (persistedDecisionId is
      // undefined), we still dispatch via the adapter but skip the delivery
      // record — using dedupeKey would violate the FK constraint.
      const persistedDecisionId = decision.persistedDecisionId;
      const hasPersistedDecision = typeof persistedDecisionId === 'string';

      try {
        if (hasPersistedDecision) {
          createDelivery({
            id: deliveryId,
            notificationDecisionId: persistedDecisionId,
            assistantId: signal.assistantId,
            channel,
            destination: destinationLabel,
            status: 'pending',
            attempt: 1,
            renderedTitle: copy.title,
            renderedBody: copy.body,
            conversationId: pairing.conversationId ?? undefined,
            messageId: pairing.messageId ?? undefined,
            conversationStrategy: pairing.strategy,
          });
        } else {
          log.warn(
            { channel, signalId: signal.signalId },
            'No persisted decision ID -- skipping delivery record creation',
          );
        }

        const adapterResult = await adapter.send(payload, destination);

        if (adapterResult.success) {
          if (hasPersistedDecision) {
            updateDeliveryStatus(deliveryId, 'sent');
          }
          results.push({
            channel,
            destination: destinationLabel,
            status: 'sent',
            sentAt: Date.now(),
            conversationId: pairing.conversationId ?? undefined,
            messageId: pairing.messageId ?? undefined,
            conversationStrategy: pairing.strategy,
          });
        } else {
          if (hasPersistedDecision) {
            updateDeliveryStatus(deliveryId, 'failed', { message: adapterResult.error });
          }
          results.push({
            channel,
            destination: destinationLabel,
            status: 'failed',
            errorMessage: adapterResult.error,
            conversationId: pairing.conversationId ?? undefined,
            messageId: pairing.messageId ?? undefined,
            conversationStrategy: pairing.strategy,
          });
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error({ err, channel, signalId: signal.signalId }, 'Unexpected error during channel delivery');

        if (hasPersistedDecision) {
          try {
            updateDeliveryStatus(deliveryId, 'failed', { message: errorMessage });
          } catch {
            // Swallow -- the delivery record may not exist if createDelivery failed
          }
        }

        results.push({
          channel,
          destination: destinationLabel,
          status: 'failed',
          errorMessage,
          conversationId: pairing.conversationId ?? undefined,
          messageId: pairing.messageId ?? undefined,
          conversationStrategy: pairing.strategy,
        });
      }
    }

    return results;
  }
}
