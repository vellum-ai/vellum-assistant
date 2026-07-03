/**
 * Background processing stage: orchestrates fire-and-forget message processing
 * after the synchronous HTTP response has been returned. Manages typing
 * indicators, approval prompt watchers, trusted contact notifications, and
 * the main agent loop invocation.
 *
 * Extracted from inbound-message-handler.ts to keep the top-level handler
 * focused on orchestration.
 */
import {
  clearThreadTs,
  extractChannelFromCallbackUrl,
  extractMessageTsFromCallbackUrl,
  extractThreadTsFromCallbackUrl,
  isSlackDeliveryCallbackUrl,
  peekThreadMapping,
  setThreadTs,
} from "../../../channels/slack-thread-store.js";
import type { ChannelId, InterfaceId } from "../../../channels/types.js";
import {
  getGuardianDelivery,
  guardianForChannel,
} from "../../../contacts/guardian-delivery-reader.js";
import type { ServerMessage } from "../../../daemon/message-protocol.js";
import type { TrustContext } from "../../../daemon/trust-context.js";
import {
  linkMessage,
  storeReplyMessageId,
  storeStreamedReplyTs,
} from "../../../persistence/delivery-crud.js";
import {
  markProcessed,
  recordProcessingFailure,
} from "../../../persistence/delivery-status.js";
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
  SlackInboundMessageMetadata,
} from "../../http-types.js";
import { hasDeliverableAssistantText } from "../../slack-no-response.js";
import { createSlackReplySession } from "../../slack-reply-session.js";
import type { TaskProgressData } from "../../slack-task-progress.js";
import {
  getTaskProgressDataFromSurfaceData,
  mergeTaskProgressData,
} from "../../slack-task-progress.js";
import { isContactTrustClass } from "../../trust-class.js";
import { resolveRoutingState } from "../../trust-context-resolver.js";
import { finalizeEventDelivery } from "../channel-delivery-routes.js";
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
  displayContent?: string;
  attachmentIds?: string[];
  sourceChannel: ChannelId;
  sourceInterface: InterfaceId;
  externalChatId: string;
  trustCtx: TrustContext;
  metadataHints: string[];
  metadataUxBrief?: string;
  replyCallbackUrl?: string;
  assistantId?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  commandIntent?: Record<string, unknown>;
  sourceLanguageCode?: string;
  /** Chat type from the gateway (e.g. "private", "group", "supergroup"). */
  chatType?: string;
  /** IANA timezone reported by the active client for the current turn. */
  clientTimezone?: string;
  /** Slack app_mention/direct bot mention signal from the gateway. */
  slackBotMentioned?: boolean;
  /**
   * Slack-specific inbound metadata extracted at the HTTP boundary. Threaded
   * through to `persistUserMessage` so the row can be tagged with a
   * `slackMeta` envelope for the chronological renderer.
   */
  slackInbound?: SlackInboundMessageMetadata;
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
    displayContent,
    attachmentIds,
    sourceChannel,
    sourceInterface,
    externalChatId,
    trustCtx,
    metadataHints,
    metadataUxBrief,
    replyCallbackUrl,
    assistantId,
    approvalCopyGenerator,
    commandIntent,
    sourceLanguageCode,
    chatType,
    clientTimezone,
    slackBotMentioned,
    slackInbound,
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
          assistantId,
        )
      : undefined;

    const slackThinkingStatus = createSlackThinkingStatusController({
      sourceChannel,
      replyCallbackUrl,
      chatId: externalChatId,
      assistantId,
      startImmediately: shouldStartSlackThinkingStatusImmediately({
        sourceChannel,
        chatType,
        slackBotMentioned,
      }),
    });
    const stopApprovalWatcher = replyCallbackUrl
      ? startPendingApprovalPromptWatcher({
          conversationId,
          sourceChannel,
          externalChatId,
          trustClass: trustCtx.trustClass,
          guardianExternalUserId: trustCtx.guardianExternalUserId,
          requesterExternalUserId: trustCtx.requesterExternalUserId,
          replyCallbackUrl,
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
          assistantId,
        })
      : undefined;

    // Align the Slack thread mapping with this turn's inbound state:
    // set it when the inbound arrived in a thread, clear it when the
    // inbound arrived at the channel root. `getThreadTs` is consulted
    // at outbound-persistence time, so the mapping must reflect the
    // current turn — a lingering mapping from a prior thread turn
    // would otherwise be stamped onto a channel-root reply.
    //
    // The update must happen BEFORE `processMessage` runs because outbound
    // persistence (inside the agent loop) reads the mapping. But if a prior
    // threaded turn is still in flight, our `processMessage` call will be
    // rejected as already-processing and our update would erase that
    // in-flight turn's mapping. Snapshot the prior state here and restore
    // it in the `already processing` rejection path below.
    let priorSlackMapping: {
      threadTs: string;
      channelId: string;
    } | null = null;
    let slackMappingMutated = false;
    if (sourceChannel === "slack" && replyCallbackUrl) {
      priorSlackMapping = peekThreadMapping(conversationId);
      const inboundThreadTs = extractThreadTsFromCallbackUrl(replyCallbackUrl);
      const inboundChannel = extractChannelFromCallbackUrl(replyCallbackUrl);
      if (inboundThreadTs && inboundChannel) {
        setThreadTs(conversationId, inboundChannel, inboundThreadTs);
        slackMappingMutated = true;
      } else {
        clearThreadTs(conversationId);
        slackMappingMutated = true;
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
      let replyMessageId: string | undefined;
      const slackReplySession = createSlackReplySession({
        sourceChannel,
        chatType,
        replyCallbackUrl,
        chatId: externalChatId,
        assistantId,
        recipientUserId: slackInbound?.actorExternalUserId,
        recipientTeamId: slackInbound?.actorTeamId,
      });
      const observeAgentEvent = (msg: ServerMessage): void => {
        if (
          msg.type === "message_complete" &&
          (msg.source === undefined || msg.source === "main") &&
          typeof msg.messageId === "string"
        ) {
          replyMessageId = msg.messageId;
        }
        slackReplySession?.observeEvent(msg);
        slackThinkingStatus?.observeEvent(msg);
      };

      let userMessageId: string | undefined;
      try {
        const result = await processMessage(conversationId, content, {
          attachmentIds,
          transport: {
            channelId: sourceChannel,
            hints: metadataHints.length > 0 ? metadataHints : undefined,
            uxBrief: metadataUxBrief,
            chatType,
            ...(clientTimezone ? { clientTimezone } : {}),
          },
          assistantId,
          trustContext: trustCtx,
          isInteractive: resolveRoutingState(trustCtx).promptWaitingAllowed,
          ...(displayContent !== undefined ? { displayContent } : {}),
          ...(cmdIntent ? { commandIntent: cmdIntent } : {}),
          ...(slackInbound ? { slackInbound } : {}),
          onEvent: observeAgentEvent,
          sourceChannel,
          sourceInterface,
        });
        userMessageId = result.messageId;
        linkMessage(eventId, userMessageId);
        markProcessed(eventId);
        replyMessageId ??= result.assistantMessageId;
        if (replyMessageId) {
          storeReplyMessageId(eventId, replyMessageId);
        }
      } catch (err) {
        // When another turn is already processing this conversation,
        // `prepareConversationForMessage` throws before any of this turn's
        // work runs. Our pre-await mapping update would otherwise stomp the
        // in-flight turn's mapping, causing its outbound persistence to
        // record `slackMeta` with the wrong (or missing) `threadTs`. Restore
        // the snapshot so the in-flight turn sees the mapping it installed.
        if (
          slackMappingMutated &&
          err instanceof Error &&
          err.message.includes("already processing a message")
        ) {
          if (priorSlackMapping) {
            setThreadTs(
              conversationId,
              priorSlackMapping.channelId,
              priorSlackMapping.threadTs,
            );
          } else {
            clearThreadTs(conversationId);
          }
        }
        log.error(
          { err, conversationId },
          "Background channel message processing failed",
        );
        if (slackReplySession) {
          const reconciliation = await slackReplySession.finish();
          if (reconciliation.mode === "streamed") {
            storeStreamedReplyTs(eventId, reconciliation.messageTs);
          }
        }
        recordProcessingFailure(eventId, err);
        return;
      }

      if (replyCallbackUrl) {
        try {
          await finalizeEventDelivery({
            eventId,
            conversationId,
            externalChatId,
            replyCallbackUrl,
            assistantId,
            replyMessageId,
            userMessageId,
            slackReplySession,
          });
        } catch (err) {
          log.error(
            { err, conversationId },
            "Background channel reply delivery failed",
          );
        }
      }
    } finally {
      stopTypingHeartbeat?.();
      slackThinkingStatus?.stop();
      stopApprovalWatcher?.();
      stopTcApprovalNotifier?.();
    }
  })();
}

// ---------------------------------------------------------------------------
// Telegram typing heartbeat
// ---------------------------------------------------------------------------

const TELEGRAM_TYPING_INTERVAL_MS = 4_000;

function shouldEmitTelegramTyping(
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

function startTelegramTypingHeartbeat(
  callbackUrl: string,
  chatId: string,
  assistantId?: string,
): () => void {
  let active = true;
  let inFlight = false;

  const emitTyping = (): void => {
    if (!active || inFlight) return;
    inFlight = true;
    void deliverChannelReply(callbackUrl, {
      chatId,
      chatAction: "typing",
      assistantId,
    })
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
// Slack Assistants API thinking status indicator
// ---------------------------------------------------------------------------

type SlackThinkingStatusController = {
  observeEvent: (msg: ServerMessage) => void;
  stop: () => void;
};

type SlackThinkingStatusHandle = {
  updateLoadingMessages: (loadingMessages?: string[]) => void;
  clear: () => void;
};

export function shouldStartSlackThinkingStatusForText(text: string): boolean {
  return hasDeliverableAssistantText(text);
}

function shouldEmitSlackThinkingStatus(
  sourceChannel: ChannelId,
  replyCallbackUrl?: string,
): boolean {
  return (
    sourceChannel === "slack" && isSlackDeliveryCallbackUrl(replyCallbackUrl)
  );
}

export function shouldStartSlackThinkingStatusImmediately(params: {
  sourceChannel: ChannelId;
  chatType?: string;
  slackBotMentioned?: boolean;
}): boolean {
  if (params.sourceChannel !== "slack") return false;
  return params.chatType === "im" || params.slackBotMentioned === true;
}

function createSlackThinkingStatusController(params: {
  sourceChannel: ChannelId;
  replyCallbackUrl?: string;
  chatId: string;
  assistantId?: string;
  startImmediately?: boolean;
}): SlackThinkingStatusController | undefined {
  const {
    sourceChannel,
    replyCallbackUrl,
    chatId,
    assistantId,
    startImmediately,
  } = params;
  if (
    !replyCallbackUrl ||
    !shouldEmitSlackThinkingStatus(sourceChannel, replyCallbackUrl)
  ) {
    return undefined;
  }
  const callbackUrl = replyCallbackUrl;

  let stopped = false;
  let slackThinkingStatus: SlackThinkingStatusHandle | undefined;
  let observedAssistantText = "";
  let currentLoadingMessages: string[] | undefined = startImmediately
    ? [...SLACK_GENERIC_LOADING_MESSAGES]
    : undefined;
  let lastSentLoadingMessageKey: string | undefined;
  const taskProgressBySurfaceId = new Map<string, TaskProgressData>();

  const start = (): void => {
    if (stopped || slackThinkingStatus) return;
    slackThinkingStatus = setSlackThinkingStatus(
      callbackUrl,
      chatId,
      assistantId,
      currentLoadingMessages,
    );
    lastSentLoadingMessageKey = getLoadingMessagesKey(currentLoadingMessages);
  };

  const maybeUpdateLoadingMessages = (): void => {
    const nextLoadingMessageKey = getLoadingMessagesKey(currentLoadingMessages);
    if (nextLoadingMessageKey === lastSentLoadingMessageKey) return;
    lastSentLoadingMessageKey = nextLoadingMessageKey;
    slackThinkingStatus?.updateLoadingMessages(currentLoadingMessages);
  };

  const observeTaskProgress = (msg: ServerMessage): void => {
    if (msg.type === "ui_surface_show") {
      const progress = getTaskProgressDataFromSurfaceData(msg.data);
      if (!progress) return;
      taskProgressBySurfaceId.set(msg.surfaceId, progress);
    } else if (msg.type === "ui_surface_update") {
      const existing = taskProgressBySurfaceId.get(msg.surfaceId);
      const progress = mergeTaskProgressData(existing, msg.data);
      if (!progress) return;
      taskProgressBySurfaceId.set(msg.surfaceId, progress);
    } else {
      return;
    }

    currentLoadingMessages =
      getTaskProgressLoadingMessage(
        taskProgressBySurfaceId.get(msg.surfaceId),
      ) ?? [];
    maybeUpdateLoadingMessages();
  };

  if (startImmediately) {
    start();
  }

  return {
    observeEvent(msg) {
      if (stopped) return;

      if (msg.type === "ui_surface_show" || msg.type === "ui_surface_update") {
        observeTaskProgress(msg);
        return;
      }

      if (slackThinkingStatus || msg.type !== "assistant_text_delta") return;

      observedAssistantText += msg.text;
      if (shouldStartSlackThinkingStatusForText(observedAssistantText)) {
        start();
      }
    },
    stop() {
      stopped = true;
      slackThinkingStatus?.clear();
    },
  };
}

const SLACK_THINKING_MAX_DURATION_MS = 120_000;
const SLACK_GENERIC_LOADING_MESSAGES = ["Thinking…"] as const;
const SLACK_THINKING_STATUSES = ["is on it", "is working hard"] as const;

function getRandomSlackThinkingStatus(): string {
  return SLACK_THINKING_STATUSES[
    Math.floor(Math.random() * SLACK_THINKING_STATUSES.length)
  ]!;
}

function getLoadingMessagesKey(loadingMessages?: string[]): string | undefined {
  return loadingMessages?.join("\n");
}

function getTaskProgressLoadingMessage(
  progress: TaskProgressData | undefined,
): string[] | undefined {
  if (!progress) return undefined;

  const activeStepIndex = progress.steps.findIndex(
    (step) => step.status === "in_progress",
  );
  if (activeStepIndex < 0) return undefined;

  const activeStep = progress.steps[activeStepIndex]!;
  return [
    `In progress (${activeStepIndex + 1}/${progress.steps.length}): ${
      activeStep.label
    }`,
  ];
}

/**
 * Set Slack Assistants API status on the thread and return a handle for
 * updating loading messages or clearing the indicator.
 *
 * A safety timer auto-clears the status after {@link SLACK_THINKING_MAX_DURATION_MS}
 * to prevent a stuck indicator when `processMessage` hangs.
 */
function setSlackThinkingStatus(
  callbackUrl: string,
  chatId: string,
  assistantId?: string,
  loadingMessages?: string[],
): SlackThinkingStatusHandle {
  let cleared = false;

  // Extract the thread timestamp from the callback URL so we can target
  // the correct thread for the Assistants API status.
  const threadTs = extractThreadTsFromCallbackUrl(callbackUrl);

  // For non-threaded DMs, fall back to emoji reaction on the original message.
  if (!threadTs) {
    const messageTs = extractMessageTsFromCallbackUrl(callbackUrl);
    if (!messageTs) {
      return {
        updateLoadingMessages: () => {},
        clear: () => {},
      };
    }

    const addPromise = deliverChannelReply(callbackUrl, {
      chatId,
      assistantId,
      reaction: { action: "add", name: "eyes", messageTs },
    }).catch((err) => {
      log.debug(
        { err, chatId, messageTs },
        "Failed to add Slack eyes reaction",
      );
    });

    const clearReaction = (): void => {
      if (cleared) return;
      cleared = true;
      clearTimeout(safetyTimer);
      void addPromise.then(() =>
        deliverChannelReply(callbackUrl, {
          chatId,
          assistantId,
          reaction: { action: "remove", name: "eyes", messageTs },
        }).catch((err) => {
          log.debug(
            { err, chatId, messageTs },
            "Failed to remove Slack eyes reaction",
          );
        }),
      );
    };

    const safetyTimer = setTimeout(
      clearReaction,
      SLACK_THINKING_MAX_DURATION_MS,
    );
    (safetyTimer as { unref?: () => void }).unref?.();

    return {
      updateLoadingMessages: () => {},
      clear: clearReaction,
    };
  }

  // Track the set promise so clear waits for it to settle first,
  // preventing a race where clear arrives at Slack before set.
  let statusPromise = deliverChannelReply(callbackUrl, {
    chatId,
    assistantId,
    assistantThreadStatus: {
      channel: chatId,
      threadTs,
      status: getRandomSlackThinkingStatus(),
      ...(loadingMessages ? { loadingMessages } : {}),
    },
  }).catch((err) => {
    log.debug({ err, chatId, threadTs }, "Failed to set Slack thinking status");
  });

  const updateLoadingMessages = (nextLoadingMessages?: string[]): void => {
    if (cleared) return;
    statusPromise = statusPromise.then(() =>
      deliverChannelReply(callbackUrl, {
        chatId,
        assistantId,
        assistantThreadStatus: {
          channel: chatId,
          threadTs,
          status: getRandomSlackThinkingStatus(),
          ...(nextLoadingMessages
            ? { loadingMessages: nextLoadingMessages }
            : {}),
        },
      }).catch((err) => {
        log.debug(
          { err, chatId, threadTs },
          "Failed to update Slack thinking status",
        );
      }),
    );
  };

  const clearStatus = (): void => {
    if (cleared) return;
    cleared = true;
    clearTimeout(safetyTimer);
    void statusPromise.then(() =>
      deliverChannelReply(callbackUrl, {
        chatId,
        assistantId,
        assistantThreadStatus: {
          channel: chatId,
          threadTs,
          status: "",
        },
      }).catch((err) => {
        log.debug(
          { err, chatId, threadTs },
          "Failed to clear Slack thinking status",
        );
      }),
    );
  };

  const safetyTimer = setTimeout(clearStatus, SLACK_THINKING_MAX_DURATION_MS);
  (safetyTimer as { unref?: () => void }).unref?.();

  return {
    updateLoadingMessages,
    clear: clearStatus,
  };
}

// ---------------------------------------------------------------------------
// Pending approval prompt watcher
// ---------------------------------------------------------------------------

const PENDING_APPROVAL_POLL_INTERVAL_MS = 300;

function startPendingApprovalPromptWatcher(params: {
  conversationId: string;
  sourceChannel: ChannelId;
  externalChatId: string;
  trustClass: TrustContext["trustClass"];
  guardianExternalUserId?: string;
  requesterExternalUserId?: string;
  replyCallbackUrl: string;
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
 * to the trusted/unverified contact when a confirmation_request enters guardian
 * approval wait. Deduplicates by requestId so each request only produces one
 * message.
 *
 * Only activates for trusted_contact and unverified_contact actors with a
 * resolvable guardian route.
 */
function startTrustedContactApprovalNotifier(params: {
  conversationId: string;
  sourceChannel: ChannelId;
  externalChatId: string;
  trustClass: TrustContext["trustClass"];
  guardianExternalUserId?: string;
  replyCallbackUrl: string;
  assistantId?: string;
}): () => void {
  const {
    conversationId,
    sourceChannel,
    externalChatId,
    trustClass,
    guardianExternalUserId,
    replyCallbackUrl,
    assistantId,
  } = params;

  // Only notify identity-known non-guardian contacts (trusted_contact and
  // unverified_contact) who have a resolvable guardian route.
  if (!isContactTrustClass(trustClass) || !guardianExternalUserId) {
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
          // Gateway-resolved guardian display name (display-only).
          const guardians = await getGuardianDelivery({
            channelTypes: [sourceChannel],
          });
          const displayName = guardians
            ? (guardianForChannel(guardians, sourceChannel)?.displayName ??
              undefined)
            : undefined;
          const guardianName = resolveGuardianName(displayName);
          const waitingText = `Waiting for ${guardianName}'s approval...`;
          try {
            await deliverChannelReply(replyCallbackUrl, {
              chatId: externalChatId,
              text: waitingText,
              assistantId: assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
            });
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
