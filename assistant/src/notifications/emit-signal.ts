/**
 * Single entry point for all notification producers.
 *
 * emitNotificationSignal() creates a NotificationSignal, persists the event,
 * runs it through the decision engine + deterministic checks + dispatch
 * pipeline. Producers call this instead of directly broadcasting IPC
 * messages or dispatching through the old patterns.
 *
 * Designed for fire-and-forget usage: errors are logged but never propagated
 * to the caller. The returned promise resolves even on failure.
 */

import { v4 as uuid } from 'uuid';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';
import { getActiveBinding } from '../memory/channel-guardian-store.js';
import { createEvent } from './events-store.js';
import { evaluateSignal } from './decision-engine.js';
import { runDeterministicChecks, type DeterministicCheckContext } from './deterministic-checks.js';
import { dispatchDecision } from './runtime-dispatch.js';
import { NotificationBroadcaster } from './broadcaster.js';
import { MacOSAdapter, type BroadcastFn } from './adapters/macos.js';
import { TelegramAdapter } from './adapters/telegram.js';
import type { NotificationSignal, AttentionHints } from './signal.js';
import type { NotificationChannel } from './types.js';

const log = getLogger('emit-signal');

// ── Broadcaster singleton ──────────────────────────────────────────────

let broadcasterInstance: NotificationBroadcaster | null = null;
let registeredBroadcastFn: BroadcastFn | null = null;

/**
 * Register the IPC broadcast function so the macOS adapter can deliver
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
      adapters.unshift(new MacOSAdapter(registeredBroadcastFn));
    }
    broadcasterInstance = new NotificationBroadcaster(adapters);
  }
  return broadcasterInstance;
}

// ── Connected channels resolution ──────────────────────────────────────

function getConnectedChannels(assistantId: string): NotificationChannel[] {
  // macOS is always considered connected (IPC socket is always available
  // when the daemon is running).
  const channels: NotificationChannel[] = ['macos'];
  // Only report Telegram as connected when there is an active guardian
  // binding for this assistant. Without a binding, the destination
  // resolver will fail to resolve a chat ID and dispatch will silently
  // drop the message — which is worse than the decision engine knowing
  // up front that the channel is unavailable.
  const telegramBinding = getActiveBinding(assistantId, 'telegram');
  if (telegramBinding) {
    channels.push('telegram');
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
  /** Optional deduplication key. */
  dedupeKey?: string;
}

/**
 * Emit a notification signal through the full pipeline:
 * createEvent -> evaluateSignal -> runDeterministicChecks -> dispatchDecision.
 *
 * Fire-and-forget safe: all errors are caught and logged. The caller
 * should not await this in critical paths unless it needs the result.
 */
export async function emitNotificationSignal(params: EmitSignalParams): Promise<void> {
  const config = getConfig();
  if (!config.notifications.enabled) {
    log.debug({ sourceEventName: params.sourceEventName }, 'Notification system disabled, skipping signal');
    return;
  }

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
      return;
    }

    // Step 2: Evaluate the signal through the decision engine
    const connectedChannels = getConnectedChannels(assistantId);
    const decision = await evaluateSignal(signal, connectedChannels);

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
        return;
      }
    }

    // Step 4: Dispatch through the broadcaster
    const broadcaster = getBroadcaster();
    const dispatchResult = await dispatchDecision(signal, decision, broadcaster);

    log.info(
      {
        signalId,
        sourceEventName: params.sourceEventName,
        dispatched: dispatchResult.dispatched,
        reason: dispatchResult.reason,
      },
      'Signal pipeline complete',
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(
      { err: errMsg, signalId, sourceEventName: params.sourceEventName },
      'Signal pipeline failed',
    );
  }
}
