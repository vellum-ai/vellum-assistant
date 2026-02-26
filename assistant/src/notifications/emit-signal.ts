/**
 * Single entry point for all notification producers.
 *
 * emitNotificationSignal() creates a NotificationSignal, persists the event,
 * and runs it through the decision engine + deterministic checks + dispatch
 * pipeline.
 *
 * Designed for fire-and-forget usage by default: errors are logged and not
 * propagated unless `throwOnError` is enabled.
 */

import { v4 as uuid } from 'uuid';

import { getDeliverableChannels } from '../channels/config.js';
import { getActiveBinding } from '../memory/channel-guardian-store.js';
import { getLogger } from '../util/logger.js';
import { type BroadcastFn, VellumAdapter } from './adapters/macos.js';
import { TelegramAdapter } from './adapters/telegram.js';
import { NotificationBroadcaster,type ThreadCreatedInfo } from './broadcaster.js';
import { enforceRoutingIntent, evaluateSignal } from './decision-engine.js';
import { type DeterministicCheckContext, runDeterministicChecks } from './deterministic-checks.js';
import { createEvent, updateEventDedupeKey } from './events-store.js';
import { dispatchDecision } from './runtime-dispatch.js';
import type { AttentionHints, NotificationSignal, RoutingIntent } from './signal.js';
import type { NotificationChannel, NotificationDeliveryResult } from './types.js';

const log = getLogger('emit-signal');

// ── Broadcaster singleton ──────────────────────────────────────────────

let broadcasterInstance: NotificationBroadcaster | null = null;
let registeredBroadcastFn: BroadcastFn | null = null;

/**
 * Register the IPC broadcast function so the vellum adapter can deliver
 * notifications through the daemon's IPC socket. Must be called once
 * during daemon startup (before any signals are emitted).
 */
export function registerBroadcastFn(fn: BroadcastFn): void {
  registeredBroadcastFn = fn;
  // Reset the broadcaster so it picks up the new broadcast function
  broadcasterInstance = null;
}

function getBroadcaster(): NotificationBroadcaster {
  if (!broadcasterInstance) {
    const adapters = [
      new TelegramAdapter(),
    ];
    if (registeredBroadcastFn) {
      adapters.unshift(new VellumAdapter(registeredBroadcastFn));
    }
    broadcasterInstance = new NotificationBroadcaster(adapters);

    // Wire the thread-created callback so the macOS client is notified
    // immediately when a vellum notification thread is paired — before
    // slower channel deliveries (e.g. Telegram) delay the IPC push.
    if (registeredBroadcastFn) {
      const broadcastFn = registeredBroadcastFn;
      broadcasterInstance.setOnThreadCreated((info) => {
        broadcastFn({
          type: 'notification_thread_created',
          conversationId: info.conversationId,
          title: info.title,
          sourceEventName: info.sourceEventName,
        });
        log.info(
          { conversationId: info.conversationId },
          'Emitted notification_thread_created push event',
        );
      });
    }
  }
  return broadcasterInstance;
}

// ── Connected channels resolution ──────────────────────────────────────

function getConnectedChannels(assistantId: string): NotificationChannel[] {
  const channels: NotificationChannel[] = [];

  // getDeliverableChannels() returns ChannelId[] but every returned channel
  // has deliveryEnabled: true, making it a valid NotificationChannel at
  // runtime. We iterate over the broad type and narrow via the switch.
  for (const channel of getDeliverableChannels()) {
    switch (channel) {
      case 'vellum':
        // Vellum is always considered connected (IPC socket is always
        // available when the daemon is running).
        channels.push(channel);
        break;
      case 'telegram':
        // Only report binding-based channels as connected when there is
        // an active guardian binding for this assistant. Without a
        // binding, the destination resolver will fail to resolve a
        // delivery endpoint and dispatch will silently drop the
        // message — which is worse than the decision engine knowing up
        // front that the channel is unavailable.
        if (getActiveBinding(assistantId, channel)) {
          channels.push(channel);
        }
        break;
      default:
        // Future deliverable channels — skip until a connectivity check
        // is implemented for them.
        break;
    }
  }

  return channels;
}

// ── Public API ─────────────────────────────────────────────────────────

export interface EmitSignalParams {
  /** Free-form event name, e.g. 'reminder.fired', 'schedule.complete'. */
  sourceEventName: string;
  /** Source channel that produced the event. */
  sourceChannel: string;
  /** Session or conversation ID from the source context. */
  sourceSessionId: string;
  /** Logical assistant ID (defaults to 'self'). */
  assistantId?: string;
  /** Attention hints for the decision engine. */
  attentionHints: AttentionHints;
  /** Arbitrary context payload passed to the decision engine. */
  contextPayload?: Record<string, unknown>;
  /** Routing intent from the source (e.g. reminder). Controls post-decision channel enforcement. */
  routingIntent?: RoutingIntent;
  /** Free-form hints from the source for the decision engine. */
  routingHints?: Record<string, unknown>;
  /** Optional deduplication key. */
  dedupeKey?: string;
  /**
   * Optional callback invoked immediately when the broadcaster pairs a vellum
   * thread and emits `notification_thread_created`.
   */
  onThreadCreated?: (info: ThreadCreatedInfo) => void;
  /**
   * When true, rethrow pipeline errors to the caller instead of only logging.
   * Useful for direct user-invoked actions that must fail closed.
   */
  throwOnError?: boolean;
}

export interface EmitSignalResult {
  signalId: string;
  deduplicated: boolean;
  dispatched: boolean;
  reason: string;
  deliveryResults: NotificationDeliveryResult[];
}

/**
 * Emit a notification signal through the full pipeline:
 * createEvent -> evaluateSignal -> runDeterministicChecks -> dispatchDecision.
 *
 * Fire-and-forget safe by default: errors are caught and logged unless
 * `throwOnError` is enabled by the caller.
 */
export async function emitNotificationSignal(params: EmitSignalParams): Promise<EmitSignalResult> {
  const signalId = uuid();
  const assistantId = params.assistantId ?? 'self';

  const signal: NotificationSignal = {
    signalId,
    assistantId,
    createdAt: Date.now(),
    sourceChannel: params.sourceChannel,
    sourceSessionId: params.sourceSessionId,
    sourceEventName: params.sourceEventName,
    contextPayload: params.contextPayload ?? {},
    attentionHints: params.attentionHints,
    routingIntent: params.routingIntent,
    routingHints: params.routingHints,
  };

  try {
    // Step 1: Persist the event
    const eventRow = createEvent({
      id: signalId,
      assistantId,
      sourceEventName: params.sourceEventName,
      sourceChannel: params.sourceChannel,
      sourceSessionId: params.sourceSessionId,
      attentionHints: params.attentionHints,
      payload: params.contextPayload ?? {},
      dedupeKey: params.dedupeKey,
    });

    if (!eventRow) {
      log.info({ signalId, dedupeKey: params.dedupeKey }, 'Signal deduplicated at event store level');
      return {
        signalId,
        deduplicated: true,
        dispatched: false,
        reason: 'Signal deduplicated at event store level',
        deliveryResults: [],
      };
    }

    // Step 2: Evaluate the signal through the decision engine
    const connectedChannels = getConnectedChannels(assistantId);
    let decision = await evaluateSignal(signal, connectedChannels);

    // Step 2.5: Enforce routing intent policy (fire-time guard)
    decision = enforceRoutingIntent(decision, signal.routingIntent, connectedChannels);

    // Persist model-generated dedupeKey back to the event row so future
    // signals can deduplicate against it (the event was created with
    // only the producer's dedupeKey, which may be null).
    if (decision.dedupeKey && !params.dedupeKey) {
      try {
        updateEventDedupeKey(signalId, decision.dedupeKey);
      } catch (err) {
        log.warn({ err, signalId }, 'Failed to persist decision dedupeKey to event row');
      }
    }

    // Step 3: Run deterministic pre-send checks
    if (decision.shouldNotify) {
      const checkContext: DeterministicCheckContext = {
        connectedChannels,
      };
      const checkResult = await runDeterministicChecks(signal, decision, checkContext);

      if (!checkResult.passed) {
        log.info(
          { signalId, reason: checkResult.reason },
          'Signal blocked by deterministic checks',
        );
        return {
          signalId,
          deduplicated: false,
          dispatched: false,
          reason: `Signal blocked by deterministic checks: ${checkResult.reason}`,
          deliveryResults: [],
        };
      }
    }

    // Step 4: Dispatch through the broadcaster
    // Note: notification_thread_created IPC events are emitted eagerly inside
    // the broadcaster as soon as vellum conversation pairing succeeds, rather
    // than after all channel deliveries complete. This avoids a race where
    // slow Telegram delivery delays the push past the macOS deep-link retry.
    const broadcaster = getBroadcaster();
    const dispatchResult = await dispatchDecision(
      signal,
      decision,
      broadcaster,
      params.onThreadCreated ? { onThreadCreated: params.onThreadCreated } : undefined,
    );

    log.info(
      {
        signalId,
        sourceEventName: params.sourceEventName,
        dispatched: dispatchResult.dispatched,
        reason: dispatchResult.reason,
      },
      'Signal pipeline complete',
    );
    return {
      signalId,
      deduplicated: false,
      dispatched: dispatchResult.dispatched,
      reason: dispatchResult.reason,
      deliveryResults: dispatchResult.deliveryResults,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(
      { err: errMsg, signalId, sourceEventName: params.sourceEventName },
      'Signal pipeline failed',
    );
    if (params.throwOnError) {
      throw err instanceof Error ? err : new Error(errMsg);
    }
    return {
      signalId,
      deduplicated: false,
      dispatched: false,
      reason: `Signal pipeline failed: ${errMsg}`,
      deliveryResults: [],
    };
  }
}
