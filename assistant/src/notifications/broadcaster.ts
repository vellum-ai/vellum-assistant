/**
 * NotificationBroadcaster -- dispatches a notification to all selected
 * channels through their respective adapters.
 *
 * For each channel the broadcaster:
 *   1. Resolves the destination via the destination-resolver
 *   2. Generates channel-specific copy via the copy-composer
 *   3. Dispatches through the channel adapter
 *   4. Records a delivery audit row in the deliveries-store
 */

import { v4 as uuid } from 'uuid';
import { getLogger } from '../util/logger.js';
import { composeCopy } from './copy-composer.js';
import { resolveDestinations } from './destination-resolver.js';
import { createDelivery, updateDeliveryStatus } from './deliveries-store.js';
import type {
  NotificationChannel,
  NotificationDeliveryResult,
  ChannelAdapter,
} from './types.js';

const log = getLogger('notif-broadcaster');

/**
 * Minimal envelope the broadcaster needs to dispatch a notification.
 * This replaces the old NotificationEnvelope which was tightly coupled
 * to the enum-based NotificationType.
 */
export interface BroadcastEnvelope {
  decisionId: string;
  assistantId: string;
  sourceEventName: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface BroadcastOptions {
  /** Override the set of channels to deliver to (bypasses preference resolution). */
  channels?: NotificationChannel[];
}

export class NotificationBroadcaster {
  private adapters: Map<NotificationChannel, ChannelAdapter>;

  constructor(adapters: ChannelAdapter[]) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      this.adapters.set(adapter.channel, adapter);
    }
  }

  /**
   * Broadcast a notification to the given set of channels.
   *
   * Returns an array of delivery results -- one per channel attempted.
   */
  async broadcast(
    envelope: BroadcastEnvelope,
    enabledChannels: NotificationChannel[],
    _options?: BroadcastOptions,
  ): Promise<NotificationDeliveryResult[]> {
    const destinations = resolveDestinations(envelope.assistantId, enabledChannels);
    const results: NotificationDeliveryResult[] = [];

    for (const channel of enabledChannels) {
      const adapter = this.adapters.get(channel);
      if (!adapter) {
        log.warn({ channel, decisionId: envelope.decisionId }, 'No adapter registered for channel -- skipping');
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
        log.warn({ channel, decisionId: envelope.decisionId }, 'Could not resolve destination -- skipping');
        results.push({
          channel,
          destination: '',
          status: 'skipped',
          errorMessage: `Destination not resolved for channel: ${channel}`,
        });
        continue;
      }

      const copy = composeCopy(envelope.sourceEventName, channel, envelope.payload);
      const delivery = {
        sourceEventName: envelope.sourceEventName,
        title: copy.title,
        body: copy.body,
        threadTitle: copy.threadTitle,
        threadSeedMessage: copy.threadSeedMessage,
        deepLinkMetadata: envelope.payload as Record<string, unknown>,
      };

      const deliveryId = uuid();
      const destinationLabel = destination.endpoint ?? channel;

      try {
        // Record a pending delivery row before attempting send
        createDelivery({
          id: deliveryId,
          notificationDecisionId: envelope.decisionId,
          assistantId: envelope.assistantId,
          channel,
          destination: destinationLabel,
          status: 'pending',
          attempt: 1,
          renderedTitle: copy.title,
          renderedBody: copy.body,
        });

        const adapterResult = await adapter.send(delivery, destination);

        if (adapterResult.success) {
          updateDeliveryStatus(deliveryId, 'sent');

          results.push({
            channel,
            destination: destinationLabel,
            status: 'sent',
            sentAt: Date.now(),
          });
        } else {
          updateDeliveryStatus(deliveryId, 'failed', {
            message: adapterResult.error,
          });

          results.push({
            channel,
            destination: destinationLabel,
            status: 'failed',
            errorMessage: adapterResult.error,
          });
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error({ err, channel, decisionId: envelope.decisionId }, 'Unexpected error during channel delivery');

        // Best-effort update of the delivery row
        try {
          updateDeliveryStatus(deliveryId, 'failed', { message: errorMessage });
        } catch {
          // Swallow -- the delivery record may not exist if createDelivery failed
        }

        results.push({
          channel,
          destination: destinationLabel,
          status: 'failed',
          errorMessage,
        });
      }
    }

    return results;
  }
}
