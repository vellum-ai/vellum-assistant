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
import { pairDeliveryWithConversation } from "./conversation-pairing.js";
import { composeFallbackCopy } from "./copy-composer.js";
import {
  createDelivery,
  findDeliveryByDecisionAndChannel,
  updateDeliveryStatus,
} from "./deliveries-store.js";
import { resolveDestinations } from "./destination-resolver.js";
import { parseInteractiveApprovalPayload } from "./guardian-question-mode.js";
import { nonEmpty } from "./notification-utils.js";
import type { NotificationSignal } from "./signal.js";
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ConversationAction,
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
 * Resolve structured approval context from a notification signal.
 * Returns `undefined` when the signal does not represent an approval flow.
 */
function resolveApprovalContext(
  signal: NotificationSignal,
): ApprovalUIMetadata | undefined {
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
      requestId,
      actions: buildIntroductionActionsForPayload(
        parseAccessRequestPayload(payload),
      ),
      plainTextFallback: buildAccessRequestContractText(payload),
    };
  }

  if (signal.sourceEventName === "guardian.question") {
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
    };
  }

  return undefined;
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
export type OnConversationCreatedFn = (info: ConversationCreatedInfo) => void;
export interface BroadcastDecisionOptions {
  onConversationCreated?: OnConversationCreatedFn;
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
    // timeout) can delay it past the macOS deep-link retry window.
    const orderedChannels = [...decision.selectedChannels].sort((a, b) => {
      if (a === "vellum") {
        return -1;
      }
      if (b === "vellum") {
        return 1;
      }
      return 0;
    });

    // Pre-compute fallback copy in case any channel is missing rendered copy
    let fallbackCopy: Partial<
      Record<NotificationChannel, RenderedChannelCopy>
    > | null = null;

    const approvalContext = resolveApprovalContext(signal);
    const accessRequestContext =
      signal.sourceEventName === "ingress.access_request" &&
      signal.contextPayload
        ? parseAccessRequestPayload(signal.contextPayload)
        : undefined;
    const results: NotificationDeliveryResult[] = [];

    for (const channel of orderedChannels) {
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
            "Decision copy has empty title and body — using fallback",
          );
        }
        if (!fallbackCopy) {
          fallbackCopy = composeFallbackCopy(signal, decision.selectedChannels);
        }
        copy = fallbackCopy[channel];
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
      // and informative — LLM rewording just adds noise.
      if (signal.contextPayload?.requestKind === "tool_grant_request") {
        if (!fallbackCopy) {
          fallbackCopy = composeFallbackCopy(signal, decision.selectedChannels);
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
          log.info(
            {
              channel,
              signalId: signal.signalId,
              existingDeliveryId: existingDelivery.id,
            },
            "Delivery already exists for this decision+channel — skipping duplicate",
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

      // For the vellum and platform channels, merge the conversationId into
      // deep-link metadata so clients can navigate directly to the conversation
      // (macOS reads it from notification_intent; the platform relays it to
      // iOS inside the APNs payload as deep_link). Prefer the
      // paired conversation (interactive opt-in flows); otherwise fall back
      // to the originating conversation referenced by `sourceContextId` when it
      // resolves to a real row. Sentinel context ids (job IDs, call session IDs,
      // access-req-* strings) leave the deep link without a conversation, and
      // the client opens the app to its default landing.
      let deepLinkTarget = decision.deepLinkTarget;
      if (channel === "vellum" || channel === "platform") {
        const deepLinkConversationId =
          pairing.conversationId ??
          resolveSourceConversationId(signal.sourceContextId);
        if (deepLinkConversationId) {
          deepLinkTarget = {
            ...deepLinkTarget,
            conversationId: deepLinkConversationId,
          };
          if (pairing.messageId) {
            deepLinkTarget = {
              ...deepLinkTarget,
              messageId: pairing.messageId,
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
        // rows before emitNotificationSignal() returns.
        if (options?.onConversationCreated) {
          try {
            options.onConversationCreated(info);
          } catch (err) {
            log.error(
              { err, signalId: signal.signalId },
              "per-dispatch onConversationCreated callback failed — continuing broadcast",
            );
          }
        }

        // Emit notification_conversation_created event only when a NEW
        // conversation was actually created. Reusing an existing conversation
        // should not fire the event — the client already knows about the
        // conversation.
        if (
          pairing.createdNewConversation &&
          pairing.strategy === "start_new_conversation"
        ) {
          if (this.onConversationCreated) {
            try {
              this.onConversationCreated(info);
            } catch (err) {
              log.error(
                { err, signalId: signal.signalId },
                "onConversationCreated callback failed — continuing broadcast",
              );
            }
          }
        }
      }

      const deliveryId = uuid();
      const destinationLabel = destination.endpoint ?? channel;

      const payload: ChannelDeliveryPayload = {
        deliveryId,
        sourceEventName: signal.sourceEventName,
        copy,
        deepLinkTarget,
        contextPayload: signal.contextPayload,
        urgency: signal.attentionHints.urgency,
        approvalContext,
        accessRequestContext,
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

        const adapterResult = await adapter.send(payload, destination);

        if (adapterResult.success) {
          // Prefer the channel-native id the adapter just captured (e.g.
          // Slack `ts`) so later edits can target the same message; fall
          // back to the pairing-supplied id for channels that surface it
          // through conversation pairing instead.
          const resolvedMessageId =
            adapterResult.messageId ?? pairing.messageId ?? undefined;
          if (hasPersistedDecision) {
            updateDeliveryStatus(
              deliveryId,
              "sent",
              undefined,
              adapterResult.messageId
                ? { messageId: adapterResult.messageId }
                : undefined,
            );
          }
          results.push({
            channel,
            destination: destinationLabel,
            status: "sent",
            sentAt: Date.now(),
            conversationId: pairing.conversationId ?? undefined,
            messageId: resolvedMessageId,
            conversationStrategy: pairing.strategy,
          });
        } else {
          if (hasPersistedDecision) {
            updateDeliveryStatus(deliveryId, "failed", {
              message: adapterResult.error,
            });
          }
          results.push({
            channel,
            destination: destinationLabel,
            status: "failed",
            errorMessage: adapterResult.error,
            conversationId: pairing.conversationId ?? undefined,
            messageId: pairing.messageId ?? undefined,
            conversationStrategy: pairing.strategy,
          });
        }
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
            // Swallow -- the delivery record may not exist if createDelivery failed
          }
        }

        results.push({
          channel,
          destination: destinationLabel,
          status: "failed",
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
