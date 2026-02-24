/**
 * NotificationOrchestrator — the single entry point for notification
 * producers to emit notifications through the unified delivery pipeline.
 *
 * Flow:
 *   1. Determine delivery class from the notification type
 *   2. Deduplicate via dedupeKey (if provided)
 *   3. Create a notification event record
 *   4. Resolve enabled channels from user preferences
 *   5. Dispatch through the broadcaster (which handles per-channel copy,
 *      destination resolution, adapter dispatch, and delivery recording)
 *   6. Return the created event and delivery results
 */

import { v4 as uuid } from 'uuid';
import { getLogger } from '../util/logger.js';
import { createEvent, type NotificationEventRow } from './events-store.js';
import { getEnabledChannels } from './preferences-store.js';
import { NotificationBroadcaster } from './broadcaster.js';
import {
  NOTIFICATION_DELIVERY_CLASS_MAP,
  NotificationDeliveryClass,
  type NotificationSignalContext,
  type NotificationEnvelope,
  type NotificationDeliveryResult,
  type NotificationChannel,
  type ChannelAdapter,
} from './types.js';

const log = getLogger('notif-orchestrator');

export interface OrchestratorOptions {
  /** Override which channels to deliver to, bypassing preference lookup. */
  channels?: NotificationChannel[];
}

export interface OrchestratorResult {
  /** The created notification event, or null if deduplicated. */
  event: NotificationEventRow | null;
  /** Per-channel delivery results. Empty if the event was deduplicated or local-only. */
  deliveries: NotificationDeliveryResult[];
  /** Whether the notification was suppressed by deduplication. */
  deduplicated: boolean;
}

export class NotificationOrchestrator {
  private broadcaster: NotificationBroadcaster;

  constructor(adapters: ChannelAdapter[]) {
    this.broadcaster = new NotificationBroadcaster(adapters);
  }

  /**
   * Handle a notification signal from a producer.
   *
   * This is the primary entry point — producers call this with a signal
   * context describing what happened, and the orchestrator takes care of
   * event creation, preference resolution, copy generation, and delivery.
   */
  async handle(
    signal: NotificationSignalContext,
    options?: OrchestratorOptions,
  ): Promise<OrchestratorResult> {
    const deliveryClass =
      NOTIFICATION_DELIVERY_CLASS_MAP[signal.type] ?? NotificationDeliveryClass.LocalOnly;

    // Create the notification event (dedupe check happens inside createEvent)
    const eventId = uuid();
    const event = createEvent({
      id: eventId,
      assistantId: signal.assistantId,
      notificationType: signal.type,
      deliveryClass,
      sourceChannel: signal.sourceChannel,
      sourceSessionId: signal.sourceSessionId,
      sourceEventId: signal.sourceEventId,
      requiresAction: signal.requiresAction,
      payload: signal.payload,
      dedupeKey: signal.dedupeKey,
    });

    if (!event) {
      log.info(
        { type: signal.type, dedupeKey: signal.dedupeKey },
        'Notification deduplicated — skipping delivery',
      );
      return { event: null, deliveries: [], deduplicated: true };
    }

    log.info(
      { eventId: event.id, type: signal.type, deliveryClass },
      'Notification event created',
    );

    // For local-only notifications, skip cross-channel delivery entirely
    if (deliveryClass === NotificationDeliveryClass.LocalOnly) {
      log.debug({ eventId: event.id }, 'Local-only notification — no cross-channel delivery');
      return { event, deliveries: [], deduplicated: false };
    }

    // Resolve which channels should receive this notification
    const enabledChannels =
      options?.channels ?? getEnabledChannels(signal.assistantId, signal.type);

    if (enabledChannels.length === 0) {
      log.debug({ eventId: event.id, type: signal.type }, 'No enabled channels for notification type');
      return { event, deliveries: [], deduplicated: false };
    }

    // Build the envelope that flows through the delivery pipeline
    const envelope: NotificationEnvelope = {
      id: event.id,
      assistantId: signal.assistantId,
      type: signal.type,
      deliveryClass,
      priority: signal.priority ?? 'normal',
      requiresAction: signal.requiresAction,
      sourceChannel: signal.sourceChannel,
      sourceSessionId: signal.sourceSessionId,
      sourceEventId: signal.sourceEventId,
      payload: signal.payload,
      dedupeKey: signal.dedupeKey,
      createdAt: event.createdAt,
    };

    const deliveries = await this.broadcaster.broadcast(envelope, enabledChannels);

    log.info(
      {
        eventId: event.id,
        type: signal.type,
        channelCount: enabledChannels.length,
        successCount: deliveries.filter((d) => d.status === 'sent').length,
        failCount: deliveries.filter((d) => d.status === 'failed').length,
      },
      'Notification delivery complete',
    );

    return { event, deliveries, deduplicated: false };
  }
}
