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

import { v4 as uuid } from "uuid";

import { getDeliverableChannels } from "../channels/config.js";
import { findGuardianForChannel } from "../contacts/contact-store.js";
import { getLogger } from "../util/logger.js";
import { type BroadcastFn, VellumAdapter } from "./adapters/macos.js";
import { SlackAdapter } from "./adapters/slack.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import {
  type ConversationCreatedInfo,
  NotificationBroadcaster,
} from "./broadcaster.js";
import { enforceRoutingIntent, evaluateSignal } from "./decision-engine.js";
import { updateDecision } from "./decisions-store.js";
import {
  type DeterministicCheckContext,
  runDeterministicChecks,
} from "./deterministic-checks.js";
import { createEvent, updateEventDedupeKey } from "./events-store.js";
import { dispatchDecision } from "./runtime-dispatch.js";
import type {
  AttentionHints,
  NotificationContextPayload,
  NotificationSignal,
  NotificationSourceChannel,
  RoutingIntent,
} from "./signal.js";
import type {
  NotificationChannel,
  NotificationDeliveryResult,
} from "./types.js";

const log = getLogger("emit-signal");

// ── Broadcaster singleton ──────────────────────────────────────────────

let broadcasterInstance: NotificationBroadcaster | null = null;
let registeredBroadcastFn: BroadcastFn | null = null;

/**
 * Register the broadcast function so the vellum adapter can deliver
 * notifications to connected clients. Must be called once during
 * daemon startup (before any signals are emitted).
 */
export function registerBroadcastFn(fn: BroadcastFn): void {
  registeredBroadcastFn = fn;
  // Reset the broadcaster so it picks up the new broadcast function
  broadcasterInstance = null;
}

function getBroadcaster(): NotificationBroadcaster {
  if (!broadcasterInstance) {
    const adapters = [new TelegramAdapter(), new SlackAdapter()];
    if (registeredBroadcastFn) {
      adapters.unshift(new VellumAdapter(registeredBroadcastFn));
    }
    broadcasterInstance = new NotificationBroadcaster(adapters);

    // Wire the conversation-created callback so the macOS client is notified
    // immediately when a vellum notification conversation is paired — before
    // slower channel deliveries (e.g. Telegram) delay the push.
    if (registeredBroadcastFn) {
      const broadcastFn = registeredBroadcastFn;
      broadcasterInstance.setOnConversationCreated((info) => {
        broadcastFn({
          type: "notification_conversation_created",
          conversationId: info.conversationId,
          title: info.title,
          sourceEventName: info.sourceEventName,
          targetGuardianPrincipalId: info.targetGuardianPrincipalId,
        });
        log.info(
          {
            conversationId: info.conversationId,
            guardianScoped: info.targetGuardianPrincipalId != null,
          },
          "Emitted notification_conversation_created push event",
        );
      });
    }
  }
  return broadcasterInstance;
}

// ── Connected channels resolution ──────────────────────────────────────

function getConnectedChannels(): NotificationChannel[] {
  const channels: NotificationChannel[] = [];

  // getDeliverableChannels() returns ChannelId[] but every returned channel
  // has deliveryEnabled: true, making it a valid NotificationChannel at
  // runtime. We iterate over the broad type and narrow via the switch.
  for (const channel of getDeliverableChannels()) {
    switch (channel) {
      case "vellum":
        // Vellum is always considered connected (the local transport is
        // always available when the daemon is running).
        channels.push(channel);
        break;
      case "telegram": {
        // A binding-based channel is connected when the guardian has an
        // active channel entry with a valid delivery endpoint. The
        // externalChatId check ensures we don't report a channel as
        // connected when the contacts record exists but lacks the
        // delivery address the destination-resolver needs.
        const guardian = findGuardianForChannel(channel);
        if (guardian && guardian.channel.externalChatId) {
          channels.push(channel);
        }
        break;
      }
      case "slack": {
        // Slack bindings can originate from shared channels (app_mention).
        // Only consider Slack connected when the stored chat ID is a DM
        // channel (D-prefixed) to prevent leaking notifications.
        const slackGuardian = findGuardianForChannel("slack");
        const chatId = slackGuardian?.channel.externalChatId;
        if (slackGuardian && chatId && chatId.startsWith("D")) {
          channels.push(channel);
        }
        break;
      }
      default:
        // Future deliverable channels — skip until a connectivity check
        // is implemented for them.
        break;
    }
  }

  return channels;
}

// ── Public API ─────────────────────────────────────────────────────────

export interface EmitSignalParams<TEventName extends string = string> {
  /** Free-form event name, e.g. 'schedule.notify', 'schedule.complete'. */
  sourceEventName: TEventName;
  /** Source channel that produced the event — must be a registered channel. */
  sourceChannel: NotificationSourceChannel;
  /** Session or conversation ID from the source context. */
  sourceSessionId: string;
  /** Attention hints for the decision engine. */
  attentionHints: AttentionHints;
  /** Arbitrary context payload passed to the decision engine. */
  contextPayload?: NotificationContextPayload<TEventName>;
  /** Routing intent from the source (e.g. reminder). Controls post-decision channel enforcement. */
  routingIntent?: RoutingIntent;
  /** Free-form hints from the source for the decision engine. */
  routingHints?: Record<string, unknown>;
  /**
   * Per-channel conversation affinity hint. Forces the decision engine to
   * reuse the specified conversation for the given channel(s), bypassing
   * LLM conversation-routing judgment. Keyed by channel name, value is conversationId.
   */
  conversationAffinityHint?: Partial<Record<string, string>>;
  /** Optional deduplication key. */
  dedupeKey?: string;
  /**
   * Optional callback invoked immediately when the broadcaster pairs a vellum
   * conversation and emits `notification_conversation_created`.
   */
  onConversationCreated?: (info: ConversationCreatedInfo) => void;
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
export async function emitNotificationSignal<TEventName extends string>(
  params: EmitSignalParams<TEventName>,
): Promise<EmitSignalResult> {
  const signalId = uuid();

  const signal: NotificationSignal<TEventName> = {
    signalId,
    createdAt: Date.now(),
    sourceChannel: params.sourceChannel,
    sourceSessionId: params.sourceSessionId,
    sourceEventName: params.sourceEventName,
    contextPayload: (params.contextPayload ??
      {}) as NotificationContextPayload<TEventName>,
    attentionHints: params.attentionHints,
    routingIntent: params.routingIntent,
    routingHints: params.routingHints,
    conversationAffinityHint: params.conversationAffinityHint,
  };

  try {
    // Step 1: Persist the event
    const eventRow = createEvent({
      id: signalId,
      sourceEventName: params.sourceEventName,
      sourceChannel: params.sourceChannel,
      sourceSessionId: params.sourceSessionId,
      attentionHints: params.attentionHints,
      payload: params.contextPayload ?? {},
      dedupeKey: params.dedupeKey,
    });

    if (!eventRow) {
      log.info(
        { signalId, dedupeKey: params.dedupeKey },
        "Signal deduplicated at event store level",
      );
      return {
        signalId,
        deduplicated: true,
        dispatched: false,
        reason: "Signal deduplicated at event store level",
        deliveryResults: [],
      };
    }

    // Step 2: Evaluate the signal through the decision engine
    const connectedChannels = getConnectedChannels();

    log.debug(
      {
        channels: connectedChannels,
      },
      "connected channels resolved",
    );

    let decision = await evaluateSignal(signal, connectedChannels);

    // Step 2.5: Enforce routing intent policy (fire-time guard)
    const preEnforcementDecision = decision;
    decision = enforceRoutingIntent(
      decision,
      signal.routingIntent,
      connectedChannels,
    );

    // Re-persist the decision if routing intent enforcement changed it,
    // so the stored decision row matches what is actually dispatched.
    if (decision !== preEnforcementDecision && decision.persistedDecisionId) {
      try {
        updateDecision(decision.persistedDecisionId, {
          selectedChannels: decision.selectedChannels,
          reasoningSummary: decision.reasoningSummary,
          validationResults: {
            dedupeKey: decision.dedupeKey,
            channelCount: decision.selectedChannels.length,
            hasCopy: Object.keys(decision.renderedCopy).length > 0,
          },
        });
      } catch (err) {
        log.warn(
          { err, signalId },
          "Failed to re-persist decision after routing intent enforcement",
        );
      }
    }

    // Persist model-generated dedupeKey back to the event row so future
    // signals can deduplicate against it (the event was created with
    // only the producer's dedupeKey, which may be null).
    if (decision.dedupeKey && !params.dedupeKey) {
      try {
        updateEventDedupeKey(signalId, decision.dedupeKey);
      } catch (err) {
        log.warn(
          { err, signalId },
          "Failed to persist decision dedupeKey to event row",
        );
      }
    }

    // Step 3: Run deterministic pre-send checks
    if (decision.shouldNotify) {
      const checkContext: DeterministicCheckContext = {
        connectedChannels,
      };
      const checkResult = await runDeterministicChecks(
        signal,
        decision,
        checkContext,
      );

      if (!checkResult.passed) {
        log.info(
          { signalId, reason: checkResult.reason },
          "Signal blocked by deterministic checks",
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
    // Note: notification_conversation_created events are emitted eagerly inside
    // the broadcaster as soon as vellum conversation pairing succeeds, rather
    // than after all channel deliveries complete. This avoids a race where
    // slow Telegram delivery delays the push past the macOS deep-link retry.
    const broadcaster = getBroadcaster();
    const dispatchResult = await dispatchDecision(
      signal,
      decision,
      broadcaster,
      params.onConversationCreated
        ? { onConversationCreated: params.onConversationCreated }
        : undefined,
    );

    log.info(
      {
        signalId,
        sourceEventName: params.sourceEventName,
        dispatched: dispatchResult.dispatched,
        reason: dispatchResult.reason,
      },
      "Signal pipeline complete",
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
      "Signal pipeline failed",
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
