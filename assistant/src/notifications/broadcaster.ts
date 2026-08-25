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

import { v4 as uuid } from "uuid";

import { getGuardianDelivery } from "../contacts/guardian-delivery-reader.js";
import { getConversation } from "../persistence/conversation-crud.js";
import type { ApprovalUIMetadata } from "../runtime/channel-approval-types.js";
import { getLogger } from "../util/logger.js";
import {
  buildAccessRequestContractText,
  buildIntroductionActionsForPayload,
  parseAccessRequestPayload,
} from "./access-request-copy.js";
import { isGuardianSensitiveEvent } from "./adapters/macos.js";
import {
  pairDeliveryWithConversation,
  type PairingResult,
} from "./conversation-pairing.js";
import { composeFallbackCopy } from "./copy-composer.js";
import {
  createDelivery,
  findDeliveryByDecisionAndChannel,
  updateDeliveryStatus,
} from "./deliveries-store.js";
import { resolveDestinations } from "./destination-resolver.js";
import {
  buildQuestionAnswerActions,
  buildToolApprovalSourceView,
  parseGuardianQuestionPayload,
  parseInteractiveApprovalPayload,
  resolveGuardianInstructionModeFromPayload,
  type ToolApprovalSourceView,
} from "./guardian-question-mode.js";
import { nonEmpty } from "./notification-utils.js";
import type { NotificationSignal } from "./signal.js";
import type {
  ChannelAdapter,
  ChannelDeliveryObserver,
  ChannelDeliveryPayload,
  ChannelDestination,
  ConversationAction,
  DeliveryResult,
  NotificationChannel,
  NotificationDecision,
  NotificationDeliveryResult,
  RenderedChannelCopy,
} from "./types.js";

const log = getLogger("notif-broadcaster");

const APPROVAL_ACTIONS: ApprovalUIMetadata["actions"] = [
  { id: "approve_once", label: "Approve once" },
  { id: "reject", label: "Reject" },
];

/**
 * Structured approval data resolved once per broadcast, so channel adapters
 * render approval cards without re-parsing `contextPayload`.
 */
interface ResolvedApprovalContext {
  approval: ApprovalUIMetadata;
  /** Source reference for tool-approval cards (guardian.question only). */
  toolApprovalSource?: ToolApprovalSourceView;
}

/**
 * Resolve structured approval context from a notification signal.
 * Returns `undefined` when the signal does not represent an approval flow.
 */
function resolveApprovalContext(
  signal: NotificationSignal,
): ResolvedApprovalContext | undefined {
  const payload = signal.contextPayload;
  if (!payload) {
    return undefined;
  }

  if (signal.sourceEventName === "ingress.access_request") {
    const requestId = nonEmpty(
      typeof payload.requestId === "string" ? payload.requestId : undefined,
    );
    if (!requestId) {
      return undefined;
    }
    return {
      approval: {
        requestId,
        actions: buildIntroductionActionsForPayload(
          parseAccessRequestPayload(payload),
        ),
        plainTextFallback: buildAccessRequestContractText(payload),
      },
    };
  }

  if (signal.sourceEventName === "guardian.question") {
    // Answer-mode question with structured options (an ask_question prompt):
    // render the options as card actions so every channel adapter shows
    // tappable choices. Built here — once per broadcast — so adapters stay
    // rendering-only; the reply router recognizes the action ids as answer
    // selections (see parseQuestionAnswerActionId).
    const questionContext = resolveQuestionOptionsContext(payload);
    if (questionContext) {
      return questionContext;
    }

    const parsed = parseInteractiveApprovalPayload(payload);
    if (!parsed) {
      return undefined;
    }
    const requestId = parsed.requestId;

    // Extract tool context so channel adapters can render structured
    // approval cards without re-parsing contextPayload.
    let toolName: string | undefined;
    let riskLevel: string | undefined;
    let commandPreview: string | undefined;
    if (
      parsed.requestKind === "tool_approval" ||
      parsed.requestKind === "tool_grant_request"
    ) {
      toolName = nonEmpty(parsed.toolName);
      riskLevel = nonEmpty(parsed.riskLevel);
      commandPreview = nonEmpty(parsed.commandPreview);
    } else if (parsed.requestKind === "pending_question") {
      toolName = nonEmpty(parsed.toolName);
    }

    return {
      approval: {
        requestId,
        actions: APPROVAL_ACTIONS,
        plainTextFallback: `Reply "${parsed.requestCode?.toUpperCase() ?? requestId} approve" or "${parsed.requestCode?.toUpperCase() ?? requestId} reject"`,
        permissionDetails: toolName
          ? {
              toolName,
              riskLevel: riskLevel ?? "medium",
              toolInput: commandPreview ? { _summary: commandPreview } : {},
              requesterIdentifier: nonEmpty(parsed.requesterIdentifier),
            }
          : undefined,
      },
      toolApprovalSource: buildToolApprovalSourceView(parsed),
    };
  }

  return undefined;
}

/**
 * Card actions for an answer-mode `pending_question` payload carrying
 * structured options: one action per option plus Skip, ids in the
 * answer-selection scheme. Returns `undefined` for approval-mode payloads,
 * option-less questions (voice questions answer by free text), and anything
 * that fails strict parsing — those fall through to the approval/plain-text
 * paths.
 */
function resolveQuestionOptionsContext(
  payload: Record<string, unknown>,
): ResolvedApprovalContext | undefined {
  const parsed = parseGuardianQuestionPayload(payload);
  if (!parsed || parsed.requestKind !== "pending_question") {
    return undefined;
  }
  if (resolveGuardianInstructionModeFromPayload(parsed).mode !== "answer") {
    return undefined;
  }
  const options = parsed.options;
  if (!options || options.length === 0) {
    return undefined;
  }
  const requestId = nonEmpty(parsed.requestId);
  if (!requestId) {
    return undefined;
  }

  const code = parsed.requestCode?.toUpperCase() ?? requestId;
  return {
    approval: {
      requestId,
      actions: buildQuestionAnswerActions(options),
      plainTextFallback: `Reply "${code} <your answer>".`,
      intent: "question",
    },
  };
}

/** Callback invoked immediately when a vellum notification conversation is created. */
export interface ConversationCreatedInfo {
  conversationId: string;
  title: string;
  sourceEventName: string;
  /** Present when the conversation is for a guardian-sensitive notification. */
  targetGuardianPrincipalId?: string;
  /** Conversation group identifier from the signal producer (e.g. "system:scheduled"). */
  groupId?: string;
  /** Semantic source from the signal producer (e.g. "schedule", "reminder"). */
  source?: string;
  /**
   * Mirrors the vellum adapter's `silent` flag. When true the client
   * must skip the fallback OS banner — the sidebar entry still appears.
   */
  silent: boolean;
}
/**
 * A returned promise is awaited before the broadcast proceeds (and before the
 * `notification_conversation_created` event is emitted), so delivery
 * bookkeeping rows can be durable before a client can act on the conversation.
 */
export type OnConversationCreatedFn = (
  info: ConversationCreatedInfo,
) => void | Promise<void>;
export interface BroadcastDecisionOptions {
  onConversationCreated?: OnConversationCreatedFn;
  /** Deadline override for tests; defaults to PLATFORM_OUTCOME_DEADLINE_MS. */
  platformOutcomeDeadlineMs?: number;
  /**
   * Array each channel's result is appended to as it settles, and the same
   * array `broadcastDecision` returns. Pass one when a broadcast that throws
   * partway still has to be told apart from one that touched no channel: the
   * return value is lost to the throw, the sink is not.
   */
  resultsSink?: NotificationDeliveryResult[];
}

// Cap on how long the deferred vellum send waits for the platform dispatch
// outcome: a duplicate banner beats a late one.
const PLATFORM_OUTCOME_DEADLINE_MS = 2_500;

/**
 * A channel dispatch that is fully prepared (destination resolved, copy
 * rendered, conversation paired, pending delivery row created) but whose
 * adapter send has not yet run. Used to defer the vellum send until the
 * platform dispatch outcome is known.
 */
interface PendingChannelDispatch {
  adapter: ChannelAdapter;
  channel: NotificationChannel;
  destination: ChannelDestination;
  payload: ChannelDeliveryPayload;
  deliveryId: string;
  destinationLabel: string;
  pairing: PairingResult;
  hasPersistedDecision: boolean;
}

/**
 * Build a delivery result for a prepared dispatch. The single construction
 * site for every post-preparation outcome branch, so a future field cannot
 * be added to one branch and missed in another.
 */
function buildDeliveryResult(
  dispatch: PendingChannelDispatch,
  status: NotificationDeliveryResult["status"],
  overrides?: Partial<NotificationDeliveryResult>,
): NotificationDeliveryResult {
  return {
    channel: dispatch.channel,
    destination: dispatch.destinationLabel,
    status,
    conversationId: dispatch.pairing.conversationId ?? undefined,
    messageId: dispatch.pairing.messageId ?? undefined,
    conversationStrategy: dispatch.pairing.strategy,
    ...overrides,
  };
}

export class NotificationBroadcaster {
  private adapters: Map<NotificationChannel, ChannelAdapter>;
  private onConversationCreated: OnConversationCreatedFn | null = null;

  constructor(adapters: ChannelAdapter[]) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      this.adapters.set(adapter.channel, adapter);
    }
  }

  /** Register a callback that fires immediately when a vellum conversation is paired. */
  setOnConversationCreated(fn: OnConversationCreatedFn): void {
    this.onConversationCreated = fn;
  }

  /** Return the registered adapter for a channel, if any. */
  getAdapter(channel: NotificationChannel): ChannelAdapter | undefined {
    return this.adapters.get(channel);
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
    options?: BroadcastDecisionOptions,
  ): Promise<NotificationDeliveryResult[]> {
    // Pull the guardian list once so the resolver stays pure. A null list
    // (gateway unreachable) falls back to the local contacts read.
    const guardians = await getGuardianDelivery();
    const destinations = resolveDestinations(
      decision.selectedChannels,
      guardians,
    );

    // Ensure vellum is processed first so the notification_conversation_created
    // event fires immediately, before slower channel sends (e.g. Telegram 30s
    // timeout) can delay it past the macOS deep-link retry window. Platform
    // sorts second: the vellum intent carries remotePushDispatched, so its
    // deferred send (below) flushes right after the platform outcome is known
    // instead of waiting behind slower channels.
    const dispatchRank = (channel: NotificationChannel): number => {
      if (channel === "vellum") {
        return 0;
      }
      if (channel === "platform") {
        return 1;
      }
      return 2;
    };
    const orderedChannels = [...decision.selectedChannels].sort(
      (a, b) => dispatchRank(a) - dispatchRank(b),
    );

    // Pre-compute fallback copy in case any channel is missing rendered copy
    let fallbackCopy: Partial<
      Record<NotificationChannel, RenderedChannelCopy>
    > | null = null;

    const resolvedApproval = resolveApprovalContext(signal);
    const approvalContext = resolvedApproval?.approval;
    const toolApprovalSource = resolvedApproval?.toolApprovalSource;
    const accessRequestContext =
      signal.sourceEventName === "ingress.access_request" &&
      signal.contextPayload
        ? parseAccessRequestPayload(signal.contextPayload)
        : undefined;
    const results: NotificationDeliveryResult[] = options?.resultsSink ?? [];

    // Vellum pairing carried forward for the platform channel's deep link.
    // A single-pass carry is safe because orderedChannels sorts vellum first.
    let vellumPairing: {
      conversationId: string;
      messageId: string | null;
    } | null = null;

    // The vellum intent's remotePushDispatched flag must reflect the ACTUAL
    // platform dispatch outcome, not channel selection: when both channels
    // are selected, the vellum channel is still prepared first (pairing, the
    // conversation-created emission, and the pending delivery row all run
    // eagerly, so the platform deep link keeps the vellum pairing carry), but
    // its adapter send is deferred until the platform adapter reports whether
    // the platform accepted a device push. Typical cost: one fast HTTP
    // round-trip before the local banner goes out, capped at
    // PLATFORM_OUTCOME_DEADLINE_MS.
    let deferredVellumSend: PendingChannelDispatch | null = null;
    let platformRemotePushAccepted = false;
    let platformRemotePushPlatforms: ("ios" | "android")[] | undefined;
    const flushDeferredVellumSend = async (): Promise<void> => {
      if (!deferredVellumSend) {
        return;
      }
      const pending = deferredVellumSend;
      deferredVellumSend = null;
      pending.payload.remotePushDispatched = platformRemotePushAccepted;
      pending.payload.remotePushPlatforms = platformRemotePushPlatforms;
      await this.sendAndRecord(pending, signal, results);
    };

    try {
      for (const channel of orderedChannels) {
        // Platform sorts immediately after vellum, so reaching any later
        // channel means the platform outcome is settled (or the platform
        // channel was skipped): flush the deferred vellum send now so the
        // local banner is not held behind slower sends. On the vellum
        // iteration itself this is a no-op -- vellum appears at most once in
        // the decision's channels and sorts first, so nothing is deferred yet.
        if (channel !== "platform") {
          await flushDeferredVellumSend();
        }

        const adapter = this.adapters.get(channel);
        if (!adapter) {
          log.warn(
            { channel, signalId: signal.signalId },
            "No adapter registered for channel -- skipping",
          );
          results.push({
            channel,
            destination: "",
            status: "skipped",
            errorMessage: `No adapter for channel: ${channel}`,
          });
          continue;
        }

        const destination = destinations.get(channel);
        if (!destination) {
          log.warn(
            { channel, signalId: signal.signalId },
            "Could not resolve destination -- skipping",
          );
          results.push({
            channel,
            destination: "",
            status: "skipped",
            errorMessage: `Destination not resolved for channel: ${channel}`,
          });
          continue;
        }

        // Pull rendered copy from the decision; fall back to copy-composer if
        // missing or effectively blank. The decision engine's LLM occasionally
        // returns empty title/body strings that pass type-only validation, so
        // treat copy with no usable content the same as missing copy.
        let copy = decision.renderedCopy[channel];
        if (!copy || (!copy.title?.trim() && !copy.body?.trim())) {
          if (copy) {
            log.warn(
              { channel, signalId: signal.signalId },
              "Decision copy has empty title and body -- using fallback",
            );
          }
          // A policy-forced platform channel has no rendered copy of its own
          // (the decision engine renders only the channels it selected). The
          // push mirrors the in-app banner -- and the iOS dedup suppresses the
          // vellum banner in its favor -- so reuse the vellum channel's
          // rendered copy before falling back to deterministic templates.
          const vellumCopy =
            channel === "platform" ? decision.renderedCopy.vellum : undefined;
          if (vellumCopy?.body?.trim()) {
            copy = vellumCopy;
          } else {
            if (!fallbackCopy) {
              fallbackCopy = composeFallbackCopy(
                signal,
                decision.selectedChannels,
              );
            }
            copy = fallbackCopy[channel];
          }
        }

        // Fail closed: if neither the decision nor the fallback composer produced
        // a usable body, skip the channel rather than leaking the raw event name
        // as placeholder text. The pre-send `checkRenderedCopyQuality` only sees
        // `decision.renderedCopy`, so this is the last guard before delivery.
        if (!copy || !copy.body?.trim()) {
          log.warn(
            { channel, signalId: signal.signalId },
            "No usable rendered copy available -- skipping channel to avoid leaking event name",
          );
          results.push({
            channel,
            destination: destination.endpoint ?? channel,
            status: "skipped",
            errorMessage: `No usable rendered copy for channel: ${channel}`,
          });
          continue;
        }

        // For tool_grant_request signals, prefer the deterministic template seed
        // over LLM-generated prose. The enriched questionText is already concise
        // and informative -- LLM rewording just adds noise.
        if (signal.contextPayload?.requestKind === "tool_grant_request") {
          if (!fallbackCopy) {
            fallbackCopy = composeFallbackCopy(
              signal,
              decision.selectedChannels,
            );
          }
          const templateSeed = fallbackCopy[channel]?.conversationSeedMessage;
          if (templateSeed) {
            copy = { ...copy, conversationSeedMessage: templateSeed };
          }
        }

        // Resolve the per-channel conversation action from the decision (default: start_new)
        const conversationAction: ConversationAction | undefined =
          decision.conversationActions?.[channel];

        // Check for duplicate delivery BEFORE pairing to avoid side effects
        // (e.g. appending seed messages to existing conversations) on retry paths
        // where a delivery row already exists.
        const persistedDecisionId = decision.persistedDecisionId;
        const hasPersistedDecision = typeof persistedDecisionId === "string";
        if (hasPersistedDecision) {
          const existingDelivery = findDeliveryByDecisionAndChannel(
            persistedDecisionId,
            channel,
          );
          if (existingDelivery) {
            // On retry paths the vellum row already exists, so the fresh-pairing
            // carry below never runs -- seed the platform deep-link carry from
            // the duplicate row's conversation instead.
            if (channel === "vellum" && existingDelivery.conversationId) {
              vellumPairing = {
                conversationId: existingDelivery.conversationId,
                messageId: existingDelivery.messageId,
              };
            }
            log.info(
              {
                channel,
                signalId: signal.signalId,
                existingDeliveryId: existingDelivery.id,
              },
              "Delivery already exists for this decision+channel -- skipping duplicate",
            );
            results.push({
              channel,
              destination: destination.endpoint ?? channel,
              status: "skipped",
              errorMessage: "Duplicate delivery skipped",
              conversationId: existingDelivery.conversationId ?? undefined,
              messageId: existingDelivery.messageId ?? undefined,
              conversationStrategy:
                existingDelivery.conversationStrategy ?? undefined,
            });
            continue;
          }
        }

        // Pair the delivery with a conversation before sending, passing the conversation action
        // and destination binding context for channel-scoped continuation
        const pairing = await pairDeliveryWithConversation(
          signal,
          channel,
          copy,
          { conversationAction, bindingContext: destination.bindingContext },
        );

        if (channel === "vellum" && pairing.conversationId) {
          vellumPairing = {
            conversationId: pairing.conversationId,
            messageId: pairing.messageId,
          };
        }

        // For the vellum and platform channels, merge the conversationId into
        // deep-link metadata so notification taps can navigate to the
        // conversation. Prefer the channel's own pairing; platform (push_only,
        // pairs nothing) takes this broadcast's vellum pairing; otherwise fall
        // back to sourceContextId when it resolves to a real row. Sentinel
        // context ids (job IDs, call session IDs, access-req-* strings) leave
        // the deep link without a conversation, and the client opens the app to
        // its default landing.
        let deepLinkTarget = decision.deepLinkTarget;
        if (channel === "vellum" || channel === "platform") {
          const deepLinkPairing =
            channel === "platform" && !pairing.conversationId
              ? (vellumPairing ?? pairing)
              : pairing;
          const deepLinkConversationId =
            deepLinkPairing.conversationId ??
            resolveSourceConversationId(signal.sourceContextId) ??
            resolveDeepLinkConversationId(signal.contextPayload);
          if (deepLinkConversationId) {
            deepLinkTarget = {
              ...deepLinkTarget,
              conversationId: deepLinkConversationId,
            };
            if (deepLinkPairing.messageId) {
              deepLinkTarget = {
                ...deepLinkTarget,
                messageId: deepLinkPairing.messageId,
              };
            }
          }
        }

        if (channel === "vellum" && pairing.conversationId) {
          // Resolve guardian scoping for conversation-created events so clients
          // can filter guardian-sensitive conversations the same way they filter
          // guardian-sensitive notification intents.
          const guardianPrincipalId =
            typeof destination.metadata?.guardianPrincipalId === "string"
              ? destination.metadata.guardianPrincipalId
              : undefined;
          const targetGuardianPrincipalId =
            guardianPrincipalId &&
            isGuardianSensitiveEvent(signal.sourceEventName)
              ? guardianPrincipalId
              : undefined;

          const conversationTitle =
            copy.conversationTitle ?? copy.title ?? signal.sourceEventName;
          const conversationSilent =
            signal.attentionHints.urgency !== "high" &&
            signal.attentionHints.urgency !== "critical";
          const info: ConversationCreatedInfo = {
            conversationId: pairing.conversationId,
            title: conversationTitle,
            sourceEventName: signal.sourceEventName,
            targetGuardianPrincipalId,
            groupId: signal.conversationMetadata?.groupId,
            source: signal.conversationMetadata?.source,
            silent: conversationSilent,
          };

          // The per-dispatch onConversationCreated callback fires whenever a vellum
          // conversation is paired (new or reused) because callers like
          // dispatchGuardianQuestion rely on it to create delivery bookkeeping
          // rows before emitNotificationSignal() returns. A returned promise is
          // awaited so those rows are durable before the client can learn of
          // the conversation and act on its approval card.
          if (options?.onConversationCreated) {
            try {
              await options.onConversationCreated(info);
            } catch (err) {
              log.error(
                { err, signalId: signal.signalId },
                "per-dispatch onConversationCreated callback failed -- continuing broadcast",
              );
            }
          }

          // Emit notification_conversation_created event only when a NEW
          // conversation was actually created. Reusing an existing conversation
          // should not fire the event -- the client already knows about the
          // conversation.
          if (
            pairing.createdNewConversation &&
            pairing.strategy === "start_new_conversation"
          ) {
            if (this.onConversationCreated) {
              try {
                await this.onConversationCreated(info);
              } catch (err) {
                log.error(
                  { err, signalId: signal.signalId },
                  "onConversationCreated callback failed -- continuing broadcast",
                );
              }
            }
          }
        }

        const deliveryId = uuid();
        const destinationLabel = destination.endpoint ?? channel;

        const payload: ChannelDeliveryPayload = {
          deliveryId,
          correlationId: signal.signalId,
          sourceEventName: signal.sourceEventName,
          copy,
          deepLinkTarget,
          contextPayload: signal.contextPayload,
          urgency: signal.attentionHints.urgency,
          approvalContext,
          accessRequestContext,
          toolApprovalSource,
        };

        const dispatch: PendingChannelDispatch = {
          adapter,
          channel,
          destination,
          payload,
          deliveryId,
          destinationLabel,
          pairing,
          hasPersistedDecision,
        };

        // Compute conversation decision audit fields for the delivery record
        const conversationAudit = {
          conversationAction: conversationAction?.action ?? "start_new",
          conversationTargetId:
            conversationAction?.action === "reuse_existing"
              ? conversationAction.conversationId
              : undefined,
          conversationFallbackUsed: pairing.conversationFallbackUsed,
        };

        try {
          if (hasPersistedDecision) {
            createDelivery({
              id: deliveryId,
              notificationDecisionId: persistedDecisionId,
              channel,
              destination: destinationLabel,
              status: "pending",
              attempt: 1,
              renderedTitle: copy.title,
              renderedBody: copy.body,
              conversationId: pairing.conversationId ?? undefined,
              messageId: pairing.messageId ?? undefined,
              conversationStrategy: pairing.strategy,
              ...conversationAudit,
            });
          } else {
            log.warn(
              { channel, signalId: signal.signalId },
              "No persisted decision ID -- skipping delivery record creation",
            );
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(
            { err, channel, signalId: signal.signalId },
            "Failed to create delivery record",
          );
          results.push(
            buildDeliveryResult(dispatch, "failed", { errorMessage }),
          );
          continue;
        }

        if (channel === "vellum" && orderedChannels.includes("platform")) {
          // The vellum intent carries remotePushDispatched, so its send waits
          // for the platform outcome; everything else (pairing, events, the
          // pending delivery row) already ran above.
          deferredVellumSend = dispatch;
          continue;
        }

        if (channel === "platform" && deferredVellumSend) {
          // The local banner is urgent: wait for the platform outcome only up
          // to the deadline (a duplicate banner beats a late one). On expiry
          // the vellum send flushes with remotePushDispatched=false while the
          // dispatch keeps running, recording its delivery row when it
          // settles; the late outcome cannot re-flush vellum.
          const backgroundResults: NotificationDeliveryResult[] = [];
          const platformSend = this.sendAndRecord(
            dispatch,
            signal,
            backgroundResults,
            {
              onRemotePushPlatforms: (platforms) => {
                platformRemotePushPlatforms = platforms;
              },
            },
          ).then((adapterResult) => {
            platformRemotePushAccepted =
              adapterResult?.remotePushAccepted === true;
            platformRemotePushPlatforms = adapterResult?.remotePushPlatforms;
          });
          let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<"deadline">((resolve) => {
            deadlineTimer = setTimeout(
              () => resolve("deadline"),
              options?.platformOutcomeDeadlineMs ??
                PLATFORM_OUTCOME_DEADLINE_MS,
            );
          });
          const raced = await Promise.race([
            platformSend.then(() => "settled" as const),
            deadline,
          ]);
          clearTimeout(deadlineTimer);
          if (raced === "deadline") {
            log.warn(
              { channel, signalId: signal.signalId },
              "Platform dispatch outcome unknown at deadline -- sending the local banner without it",
            );
            // The in-flight dispatch's result lands in backgroundResults,
            // which this call no longer reads; its delivery row still gets
            // the real terminal status.
            results.push(buildDeliveryResult(dispatch, "pending"));
          } else {
            results.push(...backgroundResults);
          }
          await flushDeferredVellumSend();
          continue;
        }

        await this.sendAndRecord(dispatch, signal, results);
      }
    } finally {
      // Guarantees the vellum intent is emitted (and its pending delivery
      // row resolved) even when a later channel's prep throws; also covers
      // the common [vellum, platform] selection where no later channel
      // triggered the mid-loop flush.
      await flushDeferredVellumSend();
    }

    return results;
  }

  /**
   * Dispatch a prepared payload through its channel adapter and record the
   * outcome (delivery row status + results entry). Returns the adapter's
   * result, or null when the send threw. The recorded result tracks what the
   * adapter actually did, so a status write that fails after a successful
   * send is logged and swallowed rather than downgrading the result.
   */
  private async sendAndRecord(
    dispatch: PendingChannelDispatch,
    signal: NotificationSignal,
    results: NotificationDeliveryResult[],
    observer?: ChannelDeliveryObserver,
  ): Promise<DeliveryResult | null> {
    const {
      adapter,
      channel,
      destination,
      payload,
      deliveryId,
      pairing,
      hasPersistedDecision,
    } = dispatch;
    try {
      const adapterResult = await adapter.send(payload, destination, observer);

      if (adapterResult.success) {
        // Prefer the channel-native id the adapter just captured (e.g.
        // Slack `ts`) so later edits can target the same message; fall
        // back to the pairing-supplied id for channels that surface it
        // through conversation pairing instead.
        const resolvedMessageId =
          adapterResult.messageId ?? pairing.messageId ?? undefined;
        if (hasPersistedDecision) {
          try {
            updateDeliveryStatus(
              deliveryId,
              "sent",
              undefined,
              adapterResult.messageId
                ? { messageId: adapterResult.messageId }
                : undefined,
            );
          } catch (statusErr) {
            // The message is already out; a lost status write must not turn
            // this into a `failed` result. Callers read the results to decide
            // whether a retry would re-deliver, so reporting a real send as
            // failed releases the signal's dedupe claim and double-sends.
            log.warn(
              { err: statusErr, channel, signalId: signal.signalId },
              "Failed to record a sent delivery; the send itself succeeded",
            );
          }
        }
        results.push(
          buildDeliveryResult(dispatch, "sent", {
            sentAt: Date.now(),
            messageId: resolvedMessageId,
          }),
        );
      } else {
        if (hasPersistedDecision) {
          updateDeliveryStatus(deliveryId, "failed", {
            message: adapterResult.error,
          });
        }
        results.push(
          buildDeliveryResult(dispatch, "failed", {
            errorMessage: adapterResult.error,
          }),
        );
      }
      return adapterResult;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(
        { err, channel, signalId: signal.signalId },
        "Unexpected error during channel delivery",
      );

      if (hasPersistedDecision) {
        try {
          updateDeliveryStatus(deliveryId, "failed", {
            message: errorMessage,
          });
        } catch {
          // Swallow -- best-effort failure-status update
        }
      }

      results.push(buildDeliveryResult(dispatch, "failed", { errorMessage }));
      return null;
    }
  }
}

/**
 * Resolve a signal's `sourceContextId` to a conversation id if it points at a
 * real row. Producers may pass sentinels (job IDs, call session IDs,
 * `access-req-*` strings) here; those simply return undefined so the deep
 * link omits the conversation target.
 */
function resolveSourceConversationId(
  sourceContextId: string | undefined,
): string | undefined {
  if (!sourceContextId) {
    return undefined;
  }
  try {
    return getConversation(sourceContextId) ? sourceContextId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a deep-link conversation id from the signal's context payload.
 * Signal producers that do not pair a conversation (e.g. `schedule.notify`
 * in notify mode) can set `deepLinkConversationId` in the context payload so
 * push notification taps navigate to a relevant existing conversation rather
 * than the app's default landing. Validates that the id points at a real
 * conversation row before returning it.
 */
function resolveDeepLinkConversationId(
  contextPayload: Record<string, unknown> | undefined,
): string | undefined {
  const raw = contextPayload?.deepLinkConversationId;
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  try {
    return getConversation(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}
