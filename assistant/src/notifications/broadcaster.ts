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

export class NotificationBroadcaster {
  private adapters: Map<NotificationChannel, ChannelAdapter>;

  constructor(adapters: ChannelAdapter[]) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      this.adapters.set(adapter.channel, adapter);
    }
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

    // Pre-compute fallback copy in case any channel is missing rendered copy
    let fallbackCopy: Partial<Record<NotificationChannel, RenderedChannelCopy>> | null = null;

    const results: NotificationDeliveryResult[] = [];

    for (const channel of decision.selectedChannels) {
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

      const payload: ChannelDeliveryPayload = {
        sourceEventName: signal.sourceEventName,
        copy,
        deepLinkTarget: decision.deepLinkTarget,
      };

      const deliveryId = uuid();
      const destinationLabel = destination.endpoint ?? channel;

      // Use the persisted decision row ID for the FK; fall back to dedupeKey
      // only if persistence failed (in which case the FK won't resolve, but we
      // still record the delivery for debugging).
      const decisionRowId = decision.persistedDecisionId ?? decision.dedupeKey;

      try {
        createDelivery({
          id: deliveryId,
          notificationDecisionId: decisionRowId,
          assistantId: signal.assistantId,
          channel,
          destination: destinationLabel,
          status: 'pending',
          attempt: 1,
          renderedTitle: copy.title,
          renderedBody: copy.body,
        });

        const adapterResult = await adapter.send(payload, destination);

        if (adapterResult.success) {
          updateDeliveryStatus(deliveryId, 'sent');
          results.push({
            channel,
            destination: destinationLabel,
            status: 'sent',
            sentAt: Date.now(),
          });
        } else {
          updateDeliveryStatus(deliveryId, 'failed', { message: adapterResult.error });
          results.push({
            channel,
            destination: destinationLabel,
            status: 'failed',
            errorMessage: adapterResult.error,
          });
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error({ err, channel, signalId: signal.signalId }, 'Unexpected error during channel delivery');

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
