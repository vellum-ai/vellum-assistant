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

import type { GuardianDelivery } from "@vellumai/gateway-client";
import { v4 as uuid } from "uuid";

import { getDeliverableChannels } from "../channels/config.js";
import {
  getGuardianDelivery,
  guardianForChannel,
} from "../contacts/guardian-delivery-reader.js";
import type { ConversationCreateType } from "../persistence/conversation-types.js";
import { isPlatformClientConfigured } from "../platform/client.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import { withSqliteRetry } from "../util/sqlite-retry.js";
import { VellumAdapter } from "./adapters/macos.js";
import { PlatformPushAdapter } from "./adapters/platform.js";
import { SlackAdapter } from "./adapters/slack.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import {
  type ConversationCreatedInfo,
  NotificationBroadcaster,
} from "./broadcaster.js";
import { enforceRoutingIntent, evaluateSignal } from "./decision-engine.js";
import { updateDecision } from "./decisions-store.js";
import {
  checkSourceActiveSuppression,
  type DeterministicCheckContext,
  runDeterministicChecks,
} from "./deterministic-checks.js";
import { createEvent, setEventDedupeKey } from "./events-store.js";
import { writeHomeFeedItemForSignal } from "./home-feed-side-effect.js";
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

export function getBroadcaster(): NotificationBroadcaster {
  if (!broadcasterInstance) {
    broadcasterInstance = new NotificationBroadcaster([
      new VellumAdapter(broadcastMessage),
      new TelegramAdapter(),
      new SlackAdapter(),
      new PlatformPushAdapter(),
    ]);

    // Wire the conversation-created callback so the macOS client is notified
    // immediately when a vellum notification conversation is paired — before
    // slower channel deliveries (e.g. Telegram) delay the push.
    broadcasterInstance.setOnConversationCreated((info) => {
      broadcastMessage({
        type: "notification_conversation_created",
        conversationId: info.conversationId,
        title: info.title,
        sourceEventName: info.sourceEventName,
        targetGuardianPrincipalId: info.targetGuardianPrincipalId,
        groupId: info.groupId,
        source: info.source,
        silent: info.silent,
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
  return broadcasterInstance;
}

// ── Connected channels resolution ──────────────────────────────────────

/**
 * Resolve a binding-based channel's delivery endpoint (externalChatId) the
 * SAME way destination-resolver's `resolveGuardian` does: from the gateway
 * guardian delivery for this channel. Keeping connectivity aligned with
 * delivery prevents a channel being marked connected but then skipped with no
 * destination (or vice-versa).
 */
function resolveChannelChatId(
  guardians: GuardianDelivery[] | null,
  channelType: string,
): string | undefined {
  const g = guardians ? guardianForChannel(guardians, channelType) : undefined;
  return g?.externalChatId ?? undefined;
}

export async function getConnectedChannels(): Promise<NotificationChannel[]> {
  const channels: NotificationChannel[] = [];

  // Guardian bindings (ACL) come from the gateway pull; null ⇒ gateway
  // unreachable, so binding-based connectivity falls back to the local read.
  const guardians = await getGuardianDelivery();

  // getDeliverableChannels() returns ChannelId[] but every returned channel
  // has deliveryEnabled: true, making it a valid NotificationChannel at
  // runtime. We iterate over the broad type and narrow via the switch.
  for (const channel of getDeliverableChannels()) {
    switch (channel) {
      case "vellum":
        // Vellum is always considered connected (the local transport is
        // always available when the assistant is running).
        channels.push(channel);
        break;
      case "platform":
        // Platform push is treated as connected at the decision-engine
        // layer; the actual delivery path lazily resolves
        // `VellumPlatformClient.create()` in `PlatformPushAdapter.send()`
        // and reports a delivery failure when credentials are absent.
        channels.push(channel);
        break;
      case "telegram": {
        // Connected when the resolved guardian has a delivery endpoint —
        // mirroring destination-resolver so we never mark connected what
        // can't be delivered.
        if (resolveChannelChatId(guardians, channel)) {
          channels.push(channel);
        }
        break;
      }
      case "slack": {
        // Slack bindings can originate from shared channels (app_mention).
        // Only consider Slack connected when the resolved chat ID is a DM
        // channel (D-prefixed), matching destination-resolver's DM gate.
        const chatId = resolveChannelChatId(guardians, "slack");
        if (chatId && chatId.startsWith("D")) {
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
  /** Free-form event name, e.g. 'schedule.notify', 'guardian.question'. */
  sourceEventName: TEventName;
  /** Source channel that produced the event — must be a registered channel. */
  sourceChannel: NotificationSourceChannel;
  /** Opaque identifier for the source context (conversation ID, schedule ID, call session ID, etc.). */
  sourceContextId: string;
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
  /**
   * Optional metadata propagated to the conversation created by the notification
   * pipeline. Allows signal producers (e.g. the scheduler) to set groupId,
   * scheduleJobId, or override the default "notification" source on the
   * resulting conversation so it appears in the correct folder on clients.
   */
  conversationMetadata?: {
    groupId?: string;
    scheduleJobId?: string;
    source?: string;
    conversationType?: ConversationCreateType;
  };
  /**
   * When true, the vellum-channel delivery materializes a fresh conversation
   * to host the notification (and any follow-up interaction). Set this only
   * for flows where the conversation IS the interaction surface — e.g.
   * guardian.question, tool grant requests, ingress access requests. Passive
   * notifications leave this unset; they surface via the home feed and link
   * back to their originating conversation via `sourceContextId`.
   */
  requiresConversation?: boolean;
}

export interface EmitSignalResult {
  signalId: string;
  deduplicated: boolean;
  dispatched: boolean;
  reason: string;
  deliveryResults: NotificationDeliveryResult[];
  /**
   * True when the pipeline threw before reaching a verdict. Dispatch, dedupe,
   * suppression, and a blocked deterministic check are all verdicts. Callers
   * that latch their own guard on a completed emit branch on this flag;
   * `reason` is a human-facing log string and never a control signal.
   */
  pipelineFailed: boolean;
}

/**
 * True when at least one channel adapter has already been handed the signal.
 * `sent` is a completed delivery; `pending` is the platform push that passed
 * its outcome deadline and is still in flight. Both mean a retry would
 * re-deliver.
 */
function hasChannelSideEffect(
  results: readonly NotificationDeliveryResult[],
): boolean {
  return results.some((r) => r.status === "sent" || r.status === "pending");
}

/**
 * Emit a notification signal through the full pipeline:
 * createEvent -> (source-active pre-gate) -> evaluateSignal ->
 * runDeterministicChecks -> dispatchDecision.
 *
 * Source-active suppression runs before the decision engine: it depends only
 * on the signal, so a statically-suppressed signal short-circuits here without
 * paying for an LLM inference whose result would be discarded downstream.
 *
 * Fire-and-forget safe by default: errors are caught and logged unless
 * `throwOnError` is enabled by the caller.
 */
export async function emitNotificationSignal<TEventName extends string>(
  params: EmitSignalParams<TEventName>,
): Promise<EmitSignalResult> {
  const signalId = uuid();

  // The event row claims `params.dedupeKey` when it lands, and the failure
  // path below releases that claim.
  let eventPersisted = false;

  // Every channel result the broadcast produces, appended as each channel
  // settles. A throw discards the dispatch return value, so this is how the
  // failure path learns which channels already ran.
  const channelResults: NotificationDeliveryResult[] = [];

  const signal: NotificationSignal<TEventName> = {
    signalId,
    createdAt: Date.now(),
    sourceChannel: params.sourceChannel,
    sourceContextId: params.sourceContextId,
    sourceEventName: params.sourceEventName,
    contextPayload: (params.contextPayload ??
      {}) as NotificationContextPayload<TEventName>,
    attentionHints: params.attentionHints,
    dedupeKey: params.dedupeKey,
    routingIntent: params.routingIntent,
    routingHints: params.routingHints,
    conversationAffinityHint: params.conversationAffinityHint,
    conversationMetadata: params.conversationMetadata,
    requiresConversation: params.requiresConversation,
  };

  try {
    // Step 1: Persist the event. The insert contends with other writers on
    // the shared database (notably the memory worker's bulk writes), and a
    // lost signal is unrecoverable (the producer has already returned by
    // the time contention surfaces), so transient `SQLITE_BUSY`/`SQLITE_IOERR`
    // rides the shared retry helper instead of failing the pipeline.
    const eventRow = await withSqliteRetry(
      () =>
        createEvent({
          id: signalId,
          sourceEventName: params.sourceEventName,
          sourceChannel: params.sourceChannel,
          sourceContextId: params.sourceContextId,
          attentionHints: params.attentionHints,
          payload: (params.contextPayload ?? {}) as Record<string, unknown>,
          dedupeKey: params.dedupeKey,
        }),
      {
        op: "notification-create-event",
        context: { signalId, sourceEventName: params.sourceEventName },
      },
    );

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
        pipelineFailed: false,
      };
    }
    eventPersisted = true;

    // Step 1.5: Source-active pre-gate. visibleInSourceNow is a hard invariant
    // the decision engine cannot override, and it depends only on the signal —
    // so when it is set, the outcome is predetermined: suppress. Short-circuit
    // before the (LLM-backed) decision stage so statically-suppressed signals
    // (e.g. trusted-contact verification_sent) never incur an inference, a
    // discarded decision row, or an LLM-dependent home-feed mirror. The event
    // row persisted above preserves the lifecycle/audit trail.
    const sourceActiveCheck = checkSourceActiveSuppression(signal);
    if (!sourceActiveCheck.passed) {
      log.info(
        { signalId, reason: sourceActiveCheck.reason },
        "Signal suppressed before decision stage (source-active)",
      );
      return {
        signalId,
        deduplicated: false,
        dispatched: false,
        reason: `Signal suppressed: ${sourceActiveCheck.reason}`,
        deliveryResults: [],
        pipelineFailed: false,
      };
    }

    // Step 2: Evaluate the signal through the decision engine
    const connectedChannels = await getConnectedChannels();

    log.debug(
      {
        channels: connectedChannels,
      },
      "connected channels resolved",
    );

    let decision = await evaluateSignal(signal, connectedChannels);

    // Baseline for the re-persist check below. Captured before the policy
    // steps (2.5a/2.5b/2.5c) so any of them replacing the decision triggers
    // the re-persist and the stored row matches what is dispatched.
    const prePolicyDecision = decision;

    // Step 2.5a: High/critical urgency signals always get both the in-app
    // system notification (vellum) and the remote push (platform),
    // regardless of what the decision engine selected. macOS surfaces a
    // banner even when the app is focused, and a suspended iOS device is
    // only reachable via APNs. Platform is only forced when the daemon has
    // platform credentials and an assistant id -- on unbound daemons the
    // dispatch can never succeed and would write a failed delivery row per
    // signal. The probe is deadline-bounded internally, so a slow credential
    // backend cannot stall the urgent dispatch.
    //
    // Vellum PREPENDS and platform APPENDS: the broadcaster re-sorts by
    // dispatch rank, so selection order only matters to single_channel
    // enforcement's first-selected fallback (step 2.5b), which must keep
    // the in-app banner rather than a push the server may skip.
    const urgency = signal.attentionHints.urgency;
    if (
      (urgency === "high" || urgency === "critical") &&
      decision.shouldNotify
    ) {
      const selectedChannels: NotificationChannel[] = [
        ...decision.selectedChannels,
      ];
      const forcedChannels: NotificationChannel[] = [];
      if (!selectedChannels.includes("vellum")) {
        selectedChannels.unshift("vellum");
        forcedChannels.push("vellum");
      }
      if (
        !selectedChannels.includes("platform") &&
        (await isPlatformClientConfigured())
      ) {
        selectedChannels.push("platform");
        forcedChannels.push("platform");
      }
      if (forcedChannels.length > 0) {
        decision = {
          ...decision,
          selectedChannels,
          reasoningSummary: `${decision.reasoningSummary} (${forcedChannels.join(", ")} forced: ${urgency} urgency)`,
        };
      }
    }

    // Step 2.5b: Enforce routing intent policy (fire-time guard)
    decision = enforceRoutingIntent(
      decision,
      signal.routingIntent,
      connectedChannels,
      signal.sourceChannel,
    );

    // Step 2.5c: Access-request signals carry a decisionable canonical
    // guardian request created before this emit, and that row suppresses
    // re-prompts for the same sender. A suppressed or vellum-less decision
    // would strand the card with no way to re-surface it, so always deliver
    // at least the in-app vellum card (a free local broadcast), whatever
    // the urgency. Runs after routing-intent enforcement — a
    // `single_channel` cap must not strip the in-app card — and before the
    // re-persist below so the stored decision matches what is dispatched.
    if (
      signal.sourceEventName === "ingress.access_request" &&
      (!decision.shouldNotify || !decision.selectedChannels.includes("vellum"))
    ) {
      decision = {
        ...decision,
        shouldNotify: true,
        selectedChannels: decision.selectedChannels.includes("vellum")
          ? decision.selectedChannels
          : ["vellum", ...decision.selectedChannels],
        reasoningSummary: `${decision.reasoningSummary} (vellum forced: decisionable access request)`,
      };
    }

    // Re-persist the decision if any policy step changed it (urgency channel
    // forcing, routing intent enforcement, or the access-request vellum
    // floor), so the stored decision row matches what is actually dispatched.
    if (decision !== prePolicyDecision && decision.persistedDecisionId) {
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
          "Failed to re-persist decision after policy enforcement",
        );
      }
    }

    // Persist model-generated dedupeKey back to the event row so future
    // signals can deduplicate against it (the event was created with
    // only the producer's dedupeKey, which may be null).
    if (decision.dedupeKey && !params.dedupeKey) {
      try {
        setEventDedupeKey(signalId, decision.dedupeKey);
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
          pipelineFailed: false,
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
      {
        onConversationCreated: params.onConversationCreated,
        resultsSink: channelResults,
      },
    );

    // Step 5: Mirror background-origin signals into the home activity feed.
    // The helper itself decides whether to write (background filter); we
    // catch and log so a feed-write failure cannot poison the dispatch result.
    // Pass the vellum delivery outcome so producers whose `sourceContextId` is
    // a sentinel string (e.g. heartbeat startup, credential health, watcher
    // emits, scheduler retries-exhausted) still get a "Go to Convo" button
    // pointing at the conversation the broadcaster paired, and so the feed can
    // tell whether that delivery left a conversation row an edit can reach.
    const vellumDelivery = dispatchResult.deliveryResults.find(
      (r) => r.channel === "vellum",
    );
    await writeHomeFeedItemForSignal(signal, decision, vellumDelivery).catch(
      (err) => {
        log.warn({ err, signalId }, "writeHomeFeedItemForSignal threw");
      },
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
      pipelineFailed: false,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(
      { err: errMsg, signalId, sourceEventName: params.sourceEventName },
      "Signal pipeline failed",
    );
    // The persisted event claimed this signal's dedupe key before the
    // pipeline threw. Leaving the claim in place makes every retry
    // short-circuit as a duplicate of an emit that never reached a verdict,
    // so release it. The row itself stays as the audit trail of the attempt.
    //
    // A partially dispatched broadcast is the exception. Its retry gets a
    // fresh decision id, and delivery dedupe is keyed to the decision, so
    // the channels that already went out would go out again. Keeping the
    // claim costs the channels that did not get the signal; releasing it
    // double-sends to the ones that did.
    if (eventPersisted && !hasChannelSideEffect(channelResults)) {
      try {
        setEventDedupeKey(signalId, null);
      } catch (releaseErr) {
        log.warn(
          { err: releaseErr, signalId },
          "Failed to release the dedupe key of a failed signal",
        );
      }
    }
    if (params.throwOnError) {
      throw err instanceof Error ? err : new Error(errMsg);
    }
    return {
      signalId,
      deduplicated: false,
      dispatched: false,
      reason: `Signal pipeline failed: ${errMsg}`,
      deliveryResults: [],
      pipelineFailed: true,
    };
  }
}
