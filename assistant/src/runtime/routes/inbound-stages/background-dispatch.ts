/**
 * Background processing stage: orchestrates fire-and-forget message processing
 * after the synchronous HTTP response has been returned. Manages typing
 * indicators, approval prompt watchers, trusted contact notifications, and
 * the main agent loop invocation.
 *
 * Extracted from inbound-message-handler.ts to keep the top-level handler
 * focused on orchestration.
 */
import type { ChannelId, InterfaceId } from "../../../channels/types.js";
import { findGuardianForChannel } from "../../../contacts/contact-store.js";
import type { TrustContext } from "../../../daemon/session-runtime-assembly.js";
import * as deliveryChannels from "../../../memory/delivery-channels.js";
import * as deliveryCrud from "../../../memory/delivery-crud.js";
import * as deliveryStatus from "../../../memory/delivery-status.js";
import {
  extractChannelFromCallbackUrl,
  extractThreadTsFromCallbackUrl,
  setThreadTs,
} from "../../../memory/slack-thread-store.js";
import { resolveGuardianName } from "../../../prompts/user-reference.js";
import { getLogger } from "../../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../assistant-scope.js";
import {
  buildApprovalUIMetadata,
  getApprovalInfoByConversation,
  getChannelApprovalPrompt,
} from "../../channel-approvals.js";
import { deliverChannelReply } from "../../gateway-client.js";
import type {
  ApprovalCopyGenerator,
  MessageProcessor,
} from "../../http-types.js";
import { resolveRoutingState } from "../../trust-context-resolver.js";
import { deliverReplyViaCallback } from "../channel-delivery-routes.js";
import { deliverGeneratedApprovalPrompt } from "../guardian-approval-prompt.js";

const log = getLogger("runtime-http");

export function isBoundGuardianActor(params: {
  trustClass: TrustContext["trustClass"];
  guardianExternalUserId?: string;
  requesterExternalUserId?: string;
}): boolean {
  const { trustClass, guardianExternalUserId, requesterExternalUserId } =
    params;

  return (
    trustClass === "guardian" &&
    !!guardianExternalUserId &&
    requesterExternalUserId === guardianExternalUserId
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BackgroundProcessingParams {
  processMessage: MessageProcessor;
  conversationId: string;
  eventId: string;
  content: string;
  attachmentIds?: string[];
  sourceChannel: ChannelId;
  sourceInterface: InterfaceId;
  externalChatId: string;
  trustCtx: TrustContext;
  metadataHints: string[];
  metadataUxBrief?: string;
  replyCallbackUrl?: string;
  /** Factory that mints a fresh delivery JWT for each HTTP attempt. */
  mintBearerToken: () => string;
  assistantId?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  commandIntent?: Record<string, unknown>;
  sourceLanguageCode?: string;
  /** External message ID (e.g. Slack message ts) used for reaction indicators. */
  externalMessageId?: string;
  /** Chat type from the gateway (e.g. "private", "group", "supergroup"). */
  chatType?: string;
}

/**
 * Fire-and-forget: process the message and deliver the reply in the background.
 * The HTTP response returns immediately so the gateway webhook is not blocked.
 */
export function processChannelMessageInBackground(
  params: BackgroundProcessingParams,
): void {
  const {
    processMessage,
    conversationId,
    eventId,
    content,
    attachmentIds,
    sourceChannel,
    sourceInterface,
    externalChatId,
    trustCtx,
    metadataHints,
    metadataUxBrief,
    replyCallbackUrl,
    mintBearerToken,
    assistantId,
    approvalCopyGenerator,
    commandIntent,
    sourceLanguageCode,
    externalMessageId,
    chatType,
  } = params;

  (async () => {
    const typingCallbackUrl = shouldEmitTelegramTyping(
      sourceChannel,
      replyCallbackUrl,
    )
      ? replyCallbackUrl
      : undefined;
    const stopTypingHeartbeat = typingCallbackUrl
      ? startTelegramTypingHeartbeat(
          typingCallbackUrl,
          externalChatId,
          mintBearerToken,
          assistantId,
        )
      : undefined;

    // Add 👀 reaction to the inbound Slack message as a processing indicator
    const removeSlackReaction =
      shouldEmitSlackReaction(sourceChannel, replyCallbackUrl) &&
      externalMessageId
        ? addSlackEyesReaction(
            replyCallbackUrl!,
            externalChatId,
            externalMessageId,
            mintBearerToken,
            assistantId,
          )
        : undefined;
    const stopApprovalWatcher = replyCallbackUrl
      ? startPendingApprovalPromptWatcher({
          conversationId,
          sourceChannel,
          externalChatId,
          trustClass: trustCtx.trustClass,
          guardianExternalUserId: trustCtx.guardianExternalUserId,
          requesterExternalUserId: trustCtx.requesterExternalUserId,
          replyCallbackUrl,
          mintBearerToken,
          assistantId,
          approvalCopyGenerator,
        })
      : undefined;
    const stopTcApprovalNotifier = replyCallbackUrl
      ? startTrustedContactApprovalNotifier({
          conversationId,
          sourceChannel,
          externalChatId,
          trustClass: trustCtx.trustClass,
          guardianExternalUserId: trustCtx.guardianExternalUserId,
          replyCallbackUrl,
          mintBearerToken,
          assistantId,
        })
      : undefined;

    // Track Slack thread mapping so replies go to the correct thread
    if (sourceChannel === "slack" && replyCallbackUrl) {
      const inboundThreadTs = extractThreadTsFromCallbackUrl(replyCallbackUrl);
      const inboundChannel = extractChannelFromCallbackUrl(replyCallbackUrl);
      if (inboundThreadTs && inboundChannel) {
        setThreadTs(conversationId, inboundChannel, inboundThreadTs);
      }
    }

    try {
      const cmdIntent =
        commandIntent && typeof commandIntent.type === "string"
          ? {
              type: commandIntent.type as string,
              ...(typeof commandIntent.payload === "string"
                ? { payload: commandIntent.payload }
                : {}),
              ...(sourceLanguageCode
                ? { languageCode: sourceLanguageCode }
                : {}),
            }
          : undefined;
      const { messageId: userMessageId } = await processMessage(
        conversationId,
        content,
        attachmentIds,
        {
          transport: {
            channelId: sourceChannel,
            hints: metadataHints.length > 0 ? metadataHints : undefined,
            uxBrief: metadataUxBrief,
            chatType,
          },
          assistantId,
          trustContext: trustCtx,
          isInteractive: resolveRoutingState(trustCtx).promptWaitingAllowed,
          ...(cmdIntent ? { commandIntent: cmdIntent } : {}),
        },
        sourceChannel,
        sourceInterface,
      );
      deliveryCrud.linkMessage(eventId, userMessageId);
      deliveryStatus.markProcessed(eventId);

      if (replyCallbackUrl) {
        await deliverReplyViaCallback(
          conversationId,
          externalChatId,
          replyCallbackUrl,
          mintBearerToken(),
          assistantId,
          {
            onSegmentDelivered: (count) =>
              deliveryChannels.updateDeliveredSegmentCount(eventId, count),
          },
        );
      }
    } catch (err) {
      log.error(
        { err, conversationId },
        "Background channel message processing failed",
      );
      deliveryStatus.recordProcessingFailure(eventId, err);
    } finally {
      stopTypingHeartbeat?.();
      removeSlackReaction?.();
      stopApprovalWatcher?.();
      stopTcApprovalNotifier?.();
    }
  })();
}

// ---------------------------------------------------------------------------
// Telegram typing heartbeat
// ---------------------------------------------------------------------------

const TELEGRAM_TYPING_INTERVAL_MS = 4_000;

export function shouldEmitTelegramTyping(
  sourceChannel: ChannelId,
  replyCallbackUrl?: string,
): boolean {
  if (sourceChannel !== "telegram" || !replyCallbackUrl) return false;
  try {
    return new URL(replyCallbackUrl).pathname.endsWith("/deliver/telegram");
  } catch {
    return replyCallbackUrl.endsWith("/deliver/telegram");
  }
}

export function startTelegramTypingHeartbeat(
  callbackUrl: string,
  chatId: string,
  mintBearerToken: () => string,
  assistantId?: string,
): () => void {
  let active = true;
  let inFlight = false;

  const emitTyping = (): void => {
    if (!active || inFlight) return;
    inFlight = true;
    void deliverChannelReply(
      callbackUrl,
      { chatId, chatAction: "typing", assistantId },
      mintBearerToken(),
    )
      .catch((err) => {
        log.debug(
          { err, chatId },
          "Failed to deliver Telegram typing indicator",
        );
      })
      .finally(() => {
        inFlight = false;
      });
  };

  emitTyping();

  const interval = setInterval(emitTyping, TELEGRAM_TYPING_INTERVAL_MS);
  (interval as { unref?: () => void }).unref?.();

  return () => {
    active = false;
    clearInterval(interval);
  };
}

// ---------------------------------------------------------------------------
// Slack eyes reaction indicator
// ---------------------------------------------------------------------------

export function shouldEmitSlackReaction(
  sourceChannel: ChannelId,
  replyCallbackUrl?: string,
): boolean {
  if (sourceChannel !== "slack" || !replyCallbackUrl) return false;
  try {
    return new URL(replyCallbackUrl).pathname.endsWith("/deliver/slack");
  } catch {
    return replyCallbackUrl.endsWith("/deliver/slack");
  }
}

const SLACK_EYES_MAX_DURATION_MS = 120_000;

/**
 * Add a 👀 reaction to the inbound Slack message and return a cleanup
 * function that removes it. Both operations are fire-and-forget.
 *
 * A safety timer auto-removes the reaction after {@link SLACK_EYES_MAX_DURATION_MS}
 * to prevent stuck eyes when `processMessage` hangs (e.g. queued behind
 * an active session turn that never completes for this message).
 */
export function addSlackEyesReaction(
  callbackUrl: string,
  chatId: string,
  messageTs: string,
  mintBearerToken: () => string,
  assistantId?: string,
): () => void {
  let removed = false;

  // Track the add promise so remove waits for it to settle first,
  // preventing a race where remove arrives at Slack before add.
  const addPromise = deliverChannelReply(
    callbackUrl,
    {
      chatId,
      assistantId,
      reaction: { action: "add", name: "eyes", messageTs },
    },
    mintBearerToken(),
  ).catch((err) => {
    log.debug({ err, chatId, messageTs }, "Failed to add Slack eyes reaction");
  });

  const removeReaction = () => {
    if (removed) return;
    removed = true;
    clearTimeout(safetyTimer);
    void addPromise.then(() =>
      deliverChannelReply(
        callbackUrl,
        {
          chatId,
          assistantId,
          reaction: { action: "remove", name: "eyes", messageTs },
        },
        mintBearerToken(),
      ).catch((err) => {
        log.debug(
          { err, chatId, messageTs },
          "Failed to remove Slack eyes reaction",
        );
      }),
    );
  };

  const safetyTimer = setTimeout(removeReaction, SLACK_EYES_MAX_DURATION_MS);
  (safetyTimer as { unref?: () => void }).unref?.();

  return removeReaction;
}

// ---------------------------------------------------------------------------
// Pending approval prompt watcher
// ---------------------------------------------------------------------------

const PENDING_APPROVAL_POLL_INTERVAL_MS = 300;

export function startPendingApprovalPromptWatcher(params: {
  conversationId: string;
  sourceChannel: ChannelId;
  externalChatId: string;
  trustClass: TrustContext["trustClass"];
  guardianExternalUserId?: string;
  requesterExternalUserId?: string;
  replyCallbackUrl: string;
  mintBearerToken: () => string;
  assistantId?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
}): () => void {
  const {
    conversationId,
    sourceChannel,
    externalChatId,
    trustClass,
    guardianExternalUserId,
    requesterExternalUserId,
    replyCallbackUrl,
    mintBearerToken,
    assistantId,
    approvalCopyGenerator,
  } = params;

  // Approval prompt delivery is guardian-only. Non-guardian and unverified
  // actors must never receive approval prompt broadcasts for the conversation.
  // We also require an explicit identity match against the bound guardian to
  // avoid broadcasting prompts when trustClass is stale/mis-scoped.
  if (
    !isBoundGuardianActor({
      trustClass,
      guardianExternalUserId,
      requesterExternalUserId,
    })
  ) {
    return () => {};
  }

  let active = true;
  const deliveredRequestIds = new Set<string>();

  const poll = async (): Promise<void> => {
    while (active) {
      try {
        const prompt = getChannelApprovalPrompt(conversationId);
        const pending = getApprovalInfoByConversation(conversationId);
        const info = pending[0];
        if (prompt && info && !deliveredRequestIds.has(info.requestId)) {
          deliveredRequestIds.add(info.requestId);
          const delivered = await deliverGeneratedApprovalPrompt({
            replyCallbackUrl,
            chatId: externalChatId,
            sourceChannel,
            assistantId: assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
            bearerToken: mintBearerToken(),
            prompt,
            uiMetadata: buildApprovalUIMetadata(prompt, info),
            messageContext: {
              scenario: "standard_prompt",
              toolName: info.toolName,
              channel: sourceChannel,
            },
            approvalCopyGenerator,
          });
          if (!delivered) {
            // Delivery can fail transiently (network or gateway outage).
            // Keep polling and retry prompt delivery for the same request.
            deliveredRequestIds.delete(info.requestId);
          }
        }
      } catch (err) {
        log.warn(
          { err, conversationId },
          "Pending approval prompt watcher failed",
        );
      }
      await delay(PENDING_APPROVAL_POLL_INTERVAL_MS);
    }
  };

  void poll();
  return () => {
    active = false;
  };
}

// ---------------------------------------------------------------------------
// Trusted contact approval notifier
// ---------------------------------------------------------------------------

// Module-level map tracking which approval requestIds have already been
// notified to trusted contacts. Maps requestId -> conversationId so that
// cleanup can be scoped to the owning conversation's poller, preventing
// concurrent pollers from different conversations from evicting each
// other's entries.
const globalNotifiedApprovalRequestIds = new Map<string, string>();

/**
 * Start a poller that sends a one-shot "waiting for guardian approval" message
 * to the trusted contact when a confirmation_request enters guardian approval
 * wait. Deduplicates by requestId so each request only produces one message.
 *
 * Only activates for trusted-contact actors with a resolvable guardian route.
 */
export function startTrustedContactApprovalNotifier(params: {
  conversationId: string;
  sourceChannel: ChannelId;
  externalChatId: string;
  trustClass: TrustContext["trustClass"];
  guardianExternalUserId?: string;
  replyCallbackUrl: string;
  mintBearerToken: () => string;
  assistantId?: string;
}): () => void {
  const {
    conversationId,
    sourceChannel,
    externalChatId,
    trustClass,
    guardianExternalUserId,
    replyCallbackUrl,
    mintBearerToken,
    assistantId,
  } = params;

  // Only notify trusted contacts who have a resolvable guardian route.
  if (trustClass !== "trusted_contact" || !guardianExternalUserId) {
    return () => {};
  }

  let active = true;

  const poll = async (): Promise<void> => {
    while (active) {
      try {
        const pending = getApprovalInfoByConversation(conversationId);
        const info = pending[0];

        // Clean up resolved requests from the module-level dedupe map.
        // Only remove entries that belong to THIS conversation — other
        // conversations' pollers own their own entries. Without this
        // scoping, concurrent pollers would evict each other's request
        // IDs and cause duplicate notifications.
        const currentPendingIds = new Set(pending.map((p) => p.requestId));
        for (const [rid, cid] of globalNotifiedApprovalRequestIds) {
          if (cid === conversationId && !currentPendingIds.has(rid)) {
            globalNotifiedApprovalRequestIds.delete(rid);
          }
        }

        if (info && !globalNotifiedApprovalRequestIds.has(info.requestId)) {
          globalNotifiedApprovalRequestIds.set(info.requestId, conversationId);
          const guardian = findGuardianForChannel(sourceChannel);
          const guardianName = resolveGuardianName(
            guardian?.contact.displayName,
          );
          const waitingText = `Waiting for ${guardianName}'s approval...`;
          try {
            await deliverChannelReply(
              replyCallbackUrl,
              {
                chatId: externalChatId,
                text: waitingText,
                assistantId: assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
              },
              mintBearerToken(),
            );
          } catch (err) {
            log.warn(
              { err, conversationId },
              "Failed to deliver trusted-contact pending-approval notification",
            );
            // Remove from notified set so delivery is retried on next poll
            globalNotifiedApprovalRequestIds.delete(info.requestId);
          }
        }
      } catch (err) {
        log.warn(
          { err, conversationId },
          "Trusted-contact approval notifier poll failed",
        );
      }
      await delay(PENDING_APPROVAL_POLL_INTERVAL_MS);
    }
  };

  void poll();
  return () => {
    active = false;

    // Evict all dedupe entries owned by this conversation so the
    // module-level map doesn't grow unboundedly after the poller stops.
    for (const [rid, cid] of globalNotifiedApprovalRequestIds) {
      if (cid === conversationId) {
        globalNotifiedApprovalRequestIds.delete(rid);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
