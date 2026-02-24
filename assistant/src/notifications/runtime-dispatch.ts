/**
 * In-loop dispatch helper that wires the decision engine output to the
 * broadcaster/adapters for end-to-end signal → decision → dispatch → delivery.
 *
 * Not a standalone service — called inline from the notification processing
 * loop after the decision engine and deterministic checks have run.
 */

import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';
import type { NotificationBroadcaster } from './broadcaster.js';
import type { NotificationSignal } from './signal.js';
import type { NotificationDecision, NotificationDeliveryResult } from './types.js';

const log = getLogger('notification-dispatch');

export interface DispatchResult {
  dispatched: boolean;
  reason: string;
  deliveryResults: NotificationDeliveryResult[];
}

/**
 * Dispatch a notification decision through the broadcaster.
 *
 * Handles three early-exit cases before delegating to the broadcaster:
 * 1. shouldNotify === false — the decision says not to notify
 * 2. Shadow mode — decisions are logged but not actually dispatched
 * 3. No selected channels — nothing to dispatch
 */
export async function dispatchDecision(
  signal: NotificationSignal,
  decision: NotificationDecision,
  broadcaster: NotificationBroadcaster,
): Promise<DispatchResult> {
  // No-op when the decision engine says not to notify
  if (!decision.shouldNotify) {
    log.info(
      { signalId: signal.signalId, reason: decision.reasoningSummary },
      'Decision: do not notify',
    );
    return {
      dispatched: false,
      reason: 'Decision: shouldNotify=false',
      deliveryResults: [],
    };
  }

  // Shadow mode: log the decision but skip actual delivery
  const config = getConfig();
  if (config.notifications.shadowMode) {
    log.info(
      {
        signalId: signal.signalId,
        channels: decision.selectedChannels,
        confidence: decision.confidence,
        fallbackUsed: decision.fallbackUsed,
      },
      'Shadow mode: skipping dispatch (decision logged only)',
    );
    return {
      dispatched: false,
      reason: 'Shadow mode enabled — dispatch skipped',
      deliveryResults: [],
    };
  }

  // Guard against empty channel list
  if (decision.selectedChannels.length === 0) {
    log.info(
      { signalId: signal.signalId },
      'No channels selected in decision — nothing to dispatch',
    );
    return {
      dispatched: false,
      reason: 'No channels selected',
      deliveryResults: [],
    };
  }

  // Dispatch through the broadcaster
  const deliveryResults = await broadcaster.broadcastDecision(signal, decision);

  const sentCount = deliveryResults.filter((r) => r.status === 'sent').length;
  log.info(
    {
      signalId: signal.signalId,
      channels: decision.selectedChannels,
      sentCount,
      totalAttempted: deliveryResults.length,
    },
    'Dispatch complete',
  );

  return {
    dispatched: true,
    reason: `Dispatched to ${sentCount}/${deliveryResults.length} channels`,
    deliveryResults,
  };
}
