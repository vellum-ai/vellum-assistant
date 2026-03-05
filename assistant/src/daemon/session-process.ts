/**
 * Queue drain and message processing logic extracted from Session.
 *
 * Session delegates `drainQueue` and `processMessage` to the module-level
 * functions exported here, following the same context-interface pattern
 * used by session-history.ts.
 */

import {
  createAssistantMessage,
  createUserMessage,
} from "../agent/message-types.js";
import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { parseChannelId, parseInterfaceId } from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { listPendingRequestsByConversationScope } from "../memory/canonical-guardian-store.js";
import * as conversationStore from "../memory/conversation-store.js";
import { provenanceFromTrustContext } from "../memory/conversation-store.js";
import { extractPreferences } from "../notifications/preference-extractor.js";
import { createPreference } from "../notifications/preferences-store.js";
import type { Message } from "../providers/types.js";
import { routeGuardianReply } from "../runtime/guardian-reply-router.js";
import { getLogger } from "../util/logger.js";
import { resolveGuardianVerificationIntent } from "./guardian-verification-intent.js";
import type { UsageStats } from "./ipc-contract.js";
import type { ServerMessage, UserMessageAttachment } from "./ipc-protocol.js";
import type { MessageQueue, QueuedMessage } from "./session-queue-manager.js";
import type { QueueDrainReason } from "./session-queue-manager.js";
import type { TrustContext } from "./session-runtime-assembly.js";
import { resolveSlash, type SlashContext } from "./session-slash.js";
import type { TraceEmitter } from "./trace-emitter.js";

const log = getLogger("session-process");

/** Build a model_info event with fresh config data. */
function buildModelInfoEvent(): ServerMessage {
  const config = getConfig();
  const configured = Object.keys(config.apiKeys).filter(
    (k) => !!config.apiKeys[k],
  );
  if (!configured.includes("ollama")) configured.push("ollama");
  return {
    type: "model_info",
    model: config.model,
    provider: config.provider,
    configuredProviders: configured,
  };
}

/** True when the trimmed content is a /model or /models slash command. */
function isModelSlashCommand(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed === "/model" ||
    trimmed === "/models" ||
    trimmed.startsWith("/model ")
  );
}

// ── Context Interface ────────────────────────────────────────────────

/**
 * Subset of Session state that drainQueue / processMessage need access to.
 * The Session class implements this interface so its instances can be
 * passed directly to the extracted functions.
 */
export interface ProcessSessionContext {
  readonly conversationId: string;
  messages: Message[];
  processing: boolean;
  abortController: AbortController | null;
  currentRequestId?: string;
  readonly queue: MessageQueue;
  readonly traceEmitter: TraceEmitter;
  currentActiveSurfaceId?: string;
  currentPage?: string;
  /** Cumulative token usage stats for the session. */
  readonly usageStats: UsageStats;
  /** Request-scoped skill IDs preactivated via slash resolution. */
  preactivatedSkillIds?: string[];
  /** Assistant identity — used for scoping notification preferences. */
  readonly assistantId?: string;
  trustContext?: TrustContext;
  ensureActorScopedHistory(): Promise<void>;
  persistUserMessage(
    content: string,
    attachments: UserMessageAttachment[],
    requestId?: string,
    metadata?: Record<string, unknown>,
    displayContent?: string,
  ): Promise<string>;
  runAgentLoop(
    content: string,
    userMessageId: string,
    onEvent: (msg: ServerMessage) => void,
    options?: {
      skipPreMessageRollback?: boolean;
      isInteractive?: boolean;
      isUserMessage?: boolean;
      titleText?: string;
    },
  ): Promise<void>;
  getTurnChannelContext(): TurnChannelContext | null;
  setTurnChannelContext(ctx: TurnChannelContext): void;
  getTurnInterfaceContext(): TurnInterfaceContext | null;
  setTurnInterfaceContext(ctx: TurnInterfaceContext): void;
  emitActivityState(
    phase:
      | "idle"
      | "thinking"
      | "streaming"
      | "tool_running"
      | "awaiting_confirmation",
    reason:
      | "message_dequeued"
      | "thinking_delta"
      | "first_text_delta"
      | "tool_use_start"
      | "tool_result_received"
      | "confirmation_requested"
      | "confirmation_resolved"
      | "message_complete"
      | "generation_cancelled"
      | "error_terminal",
    anchor?: "assistant_turn" | "user_turn" | "global",
    requestId?: string,
    statusText?: string,
  ): void;
}

function resolveQueuedTurnContext(
  queued: {
    turnChannelContext?: TurnChannelContext;
    metadata?: Record<string, unknown>;
  },
  fallback: TurnChannelContext | null,
): TurnChannelContext | null {
  if (queued.turnChannelContext) return queued.turnChannelContext;
  const metadata = queued.metadata;
  if (metadata) {
    const userMessageChannel = parseChannelId(metadata.userMessageChannel);
    const assistantMessageChannel = parseChannelId(
      metadata.assistantMessageChannel,
    );
    if (userMessageChannel && assistantMessageChannel) {
      return { userMessageChannel, assistantMessageChannel };
    }
  }
  return fallback;
}

function resolveQueuedTurnInterfaceContext(
  queued: {
    turnInterfaceContext?: TurnInterfaceContext;
    metadata?: Record<string, unknown>;
  },
  fallback: TurnInterfaceContext | null,
): TurnInterfaceContext | null {
  if (queued.turnInterfaceContext) return queued.turnInterfaceContext;
  const metadata = queued.metadata;
  if (metadata) {
    const userMessageInterface = parseInterfaceId(
      metadata.userMessageInterface,
    );
    const assistantMessageInterface = parseInterfaceId(
      metadata.assistantMessageInterface,
    );
    if (userMessageInterface && assistantMessageInterface) {
      return { userMessageInterface, assistantMessageInterface };
    }
  }
  return fallback;
}

/** Build a SlashContext from the current session state and config. */
function buildSlashContext(session: ProcessSessionContext): SlashContext {
  const config = getConfig();
  return {
    messageCount: session.messages.length,
    inputTokens: session.usageStats.inputTokens,
    outputTokens: session.usageStats.outputTokens,
    maxInputTokens: config.contextWindow.maxInputTokens,
    model: config.model,
    provider: config.provider,
    estimatedCost: session.usageStats.estimatedCost,
  };
}

// ── drainQueue ───────────────────────────────────────────────────────

/**
 * Drain all queued messages at once and process them as a batch.
 *
 * - Slash commands (unknown → persist+respond; rewritten → run individually)
 *   are handled one-at-a-time before the batch.
 * - Passthrough messages are combined into a single user message and run
 *   through a single agent loop, giving the LLM full context.
 */
export async function drainQueue(
  session: ProcessSessionContext,
  reason: QueueDrainReason = "loop_complete",
): Promise<void> {
  const all = session.queue.shiftAll();
  if (all.length === 0) return;

  for (const msg of all) {
    log.info(
      {
        conversationId: session.conversationId,
        requestId: msg.requestId,
        reason,
      },
      "Dequeuing message",
    );
    session.traceEmitter.emit(
      "request_dequeued",
      `Message dequeued (${reason})`,
      {
        requestId: msg.requestId,
        status: "info",
        attributes: { reason },
      },
    );
    msg.onEvent({
      type: "message_dequeued",
      sessionId: session.conversationId,
      requestId: msg.requestId,
    });
  }
  session.emitActivityState(
    "thinking",
    "message_dequeued",
    "assistant_turn",
    all[0].requestId,
  );

  // Partition into slash commands vs passthrough messages
  const slashMessages: Array<{
    msg: QueuedMessage;
    result: ReturnType<typeof resolveSlash>;
  }> = [];
  const passthroughMessages: QueuedMessage[] = [];

  for (const msg of all) {
    const slashResult = resolveSlash(msg.content, buildSlashContext(session));
    if (slashResult.kind === "unknown" || slashResult.kind === "rewritten") {
      slashMessages.push({ msg, result: slashResult });
    } else {
      passthroughMessages.push(msg);
    }
  }

  for (const { msg, result } of slashMessages) {
    await drainSingleSlashMessage(session, msg, result);
  }

  if (passthroughMessages.length === 0) return;

  if (passthroughMessages.length === 1) {
    await drainSinglePassthrough(session, passthroughMessages[0]);
    return;
  }

  await drainBatchPassthrough(session, passthroughMessages);
}

async function drainSingleSlashMessage(
  session: ProcessSessionContext,
  next: QueuedMessage,
  slashResult: ReturnType<typeof resolveSlash>,
): Promise<void> {
  const queuedTurnCtx = resolveQueuedTurnContext(
    next,
    session.getTurnChannelContext(),
  );
  if (queuedTurnCtx) session.setTurnChannelContext(queuedTurnCtx);
  const queuedInterfaceCtx = resolveQueuedTurnInterfaceContext(
    next,
    session.getTurnInterfaceContext(),
  );
  if (queuedInterfaceCtx) session.setTurnInterfaceContext(queuedInterfaceCtx);

  if (slashResult.kind === "unknown") {
    try {
      const drainProvenance = provenanceFromTrustContext(session.trustContext);
      const drainChannelMeta = {
        ...drainProvenance,
        ...(queuedTurnCtx
          ? {
              userMessageChannel: queuedTurnCtx.userMessageChannel,
              assistantMessageChannel: queuedTurnCtx.assistantMessageChannel,
            }
          : {}),
        ...(queuedInterfaceCtx
          ? {
              userMessageInterface: queuedInterfaceCtx.userMessageInterface,
              assistantMessageInterface:
                queuedInterfaceCtx.assistantMessageInterface,
            }
          : {}),
      };
      const userMsg = createUserMessage(next.content, next.attachments);
      const contentToPersist = next.displayContent
        ? JSON.stringify(
            createUserMessage(next.displayContent, next.attachments).content,
          )
        : JSON.stringify(userMsg.content);
      await conversationStore.addMessage(
        session.conversationId,
        "user",
        contentToPersist,
        drainChannelMeta,
      );
      session.messages.push(userMsg);

      const assistantMsg = createAssistantMessage(slashResult.message);
      await conversationStore.addMessage(
        session.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        drainChannelMeta,
      );
      session.messages.push(assistantMsg);

      if (queuedTurnCtx)
        conversationStore.setConversationOriginChannelIfUnset(
          session.conversationId,
          queuedTurnCtx.userMessageChannel,
        );
      if (queuedInterfaceCtx)
        conversationStore.setConversationOriginInterfaceIfUnset(
          session.conversationId,
          queuedInterfaceCtx.userMessageInterface,
        );

      if (isModelSlashCommand(next.content))
        next.onEvent(buildModelInfoEvent());
      next.onEvent({ type: "assistant_text_delta", text: slashResult.message });
      session.traceEmitter.emit(
        "message_complete",
        "Unknown slash command handled",
        { requestId: next.requestId, status: "success" },
      );
      next.onEvent({
        type: "message_complete",
        sessionId: session.conversationId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: session.conversationId,
          requestId: next.requestId,
        },
        "Failed to persist unknown-slash exchange",
      );
      session.traceEmitter.emit(
        "request_error",
        `Unknown-slash persist failed: ${message}`,
        {
          requestId: next.requestId,
          status: "error",
          attributes: { reason: "persist_failure" },
        },
      );
      next.onEvent({ type: "error", message });
    }
    return;
  }

  if (slashResult.kind === "rewritten") {
    session.preactivatedSkillIds = [slashResult.skillId];
    await drainSinglePassthrough(session, next);
  }
}

async function drainSinglePassthrough(
  session: ProcessSessionContext,
  next: QueuedMessage,
): Promise<void> {
  const queuedTurnCtx = resolveQueuedTurnContext(
    next,
    session.getTurnChannelContext(),
  );
  if (queuedTurnCtx) session.setTurnChannelContext(queuedTurnCtx);
  const queuedInterfaceCtx = resolveQueuedTurnInterfaceContext(
    next,
    session.getTurnInterfaceContext(),
  );
  if (queuedInterfaceCtx) session.setTurnInterfaceContext(queuedInterfaceCtx);

  const slashResult = resolveSlash(next.content, buildSlashContext(session));
  // drainSinglePassthrough is only called for passthrough/rewritten, never unknown
  const resolvedContent =
    slashResult.kind === "unknown" ? next.content : slashResult.content;

  let agentLoopContent = resolvedContent;
  if (slashResult.kind === "passthrough") {
    const guardianIntent = resolveGuardianVerificationIntent(resolvedContent);
    if (guardianIntent.kind === "direct_setup") {
      log.info(
        {
          conversationId: session.conversationId,
          channelHint: guardianIntent.channelHint,
        },
        "Guardian verification intent intercepted in queue — forcing skill flow",
      );
      agentLoopContent = guardianIntent.rewrittenContent;
      session.preactivatedSkillIds = ["guardian-verify-setup"];
    }
  }

  let userMessageId: string;
  try {
    userMessageId = await session.persistUserMessage(
      resolvedContent,
      next.attachments,
      next.requestId,
      next.metadata,
      next.displayContent,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      {
        err,
        conversationId: session.conversationId,
        requestId: next.requestId,
      },
      "Failed to persist queued message",
    );
    session.traceEmitter.emit(
      "request_error",
      `Queued message persist failed: ${message}`,
      {
        requestId: next.requestId,
        status: "error",
        attributes: { reason: "persist_failure" },
      },
    );
    next.onEvent({ type: "error", message });
    session.preactivatedSkillIds = undefined;
    return;
  }

  session.currentActiveSurfaceId = next.activeSurfaceId;
  session.currentPage = next.currentPage;

  if (session.assistantId) {
    const aid = session.assistantId;
    extractPreferences(resolvedContent)
      .then((result) => {
        if (!result.detected) return;
        for (const pref of result.preferences) {
          createPreference({
            assistantId: aid,
            preferenceText: pref.preferenceText,
            appliesWhen: pref.appliesWhen,
            priority: pref.priority,
          });
        }
      })
      .catch(() => {});
  }

  const drainLoopOptions: {
    isInteractive?: boolean;
    isUserMessage?: boolean;
    titleText?: string;
  } = { isUserMessage: true };
  if (next.isInteractive !== undefined)
    drainLoopOptions.isInteractive = next.isInteractive;
  if (agentLoopContent !== resolvedContent)
    drainLoopOptions.titleText = resolvedContent;

  session
    .runAgentLoop(
      agentLoopContent,
      userMessageId,
      next.onEvent,
      drainLoopOptions,
    )
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: session.conversationId,
          requestId: next.requestId,
        },
        "Error processing queued message",
      );
      next.onEvent({
        type: "error",
        message: `Failed to process queued message: ${message}`,
      });
    });
}

async function drainBatchPassthrough(
  session: ProcessSessionContext,
  messages: QueuedMessage[],
): Promise<void> {
  const first = messages[0];

  const queuedTurnCtx = resolveQueuedTurnContext(
    first,
    session.getTurnChannelContext(),
  );
  if (queuedTurnCtx) session.setTurnChannelContext(queuedTurnCtx);
  const queuedInterfaceCtx = resolveQueuedTurnInterfaceContext(
    first,
    session.getTurnInterfaceContext(),
  );
  if (queuedInterfaceCtx) session.setTurnInterfaceContext(queuedInterfaceCtx);

  const combinedParts: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    combinedParts.push(`[Message ${i + 1}]\n${messages[i].content}`);
  }
  const combinedContent = combinedParts.join("\n\n");

  const mergedAttachments: UserMessageAttachment[] = [];
  for (const msg of messages) mergedAttachments.push(...msg.attachments);

  const isInteractive = messages.every((m) => m.isInteractive !== false);

  const fanOutOnEvent = (event: ServerMessage) => {
    for (const msg of messages) {
      try {
        msg.onEvent(event);
      } catch {
        /* ignore */
      }
    }
  };

  let userMessageId: string;
  try {
    userMessageId = await session.persistUserMessage(
      combinedContent,
      mergedAttachments,
      first.requestId,
      first.metadata,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      {
        err,
        conversationId: session.conversationId,
        requestId: first.requestId,
      },
      "Failed to persist batched queued messages",
    );
    fanOutOnEvent({ type: "error", message });
    session.preactivatedSkillIds = undefined;
    return;
  }

  session.currentActiveSurfaceId = first.activeSurfaceId;
  session.currentPage = first.currentPage;

  if (session.assistantId) {
    const aid = session.assistantId;
    extractPreferences(combinedContent)
      .then((result) => {
        if (!result.detected) return;
        for (const pref of result.preferences) {
          createPreference({
            assistantId: aid,
            preferenceText: pref.preferenceText,
            appliesWhen: pref.appliesWhen,
            priority: pref.priority,
          });
        }
      })
      .catch(() => {});
  }

  session
    .runAgentLoop(combinedContent, userMessageId, fanOutOnEvent, {
      isUserMessage: true,
      isInteractive,
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: session.conversationId,
          requestId: first.requestId,
        },
        "Error processing batched queued messages",
      );
      fanOutOnEvent({
        type: "error",
        message: `Failed to process batched queued messages: ${message}`,
      });
    });
}

// ── processMessage ───────────────────────────────────────────────────

/**
 * Convenience function that persists a user message and runs the agent loop
 * in a single call. Used by the IPC path where blocking is expected.
 */
export async function processMessage(
  session: ProcessSessionContext,
  content: string,
  attachments: UserMessageAttachment[],
  onEvent: (msg: ServerMessage) => void,
  requestId?: string,
  activeSurfaceId?: string,
  currentPage?: string,
  options?: { isInteractive?: boolean },
  displayContent?: string,
): Promise<string> {
  await session.ensureActorScopedHistory();
  session.currentActiveSurfaceId = activeSurfaceId;
  session.currentPage = currentPage;
  const trimmedContent = content.trim();
  const canonicalPendingRequestHintIdsForConversation =
    trimmedContent.length > 0
      ? listPendingRequestsByConversationScope(
          session.conversationId,
          "vellum",
        ).map((request) => request.id)
      : [];
  const canonicalPendingRequestIdsForConversation =
    canonicalPendingRequestHintIdsForConversation.length > 0
      ? canonicalPendingRequestHintIdsForConversation
      : undefined;

  // ── Canonical guardian reply router (desktop/session path) ──
  // Desktop/session guardian replies are canonical-only. Messages consumed
  // by the router never hit the general agent loop.
  if (trimmedContent.length > 0) {
    const routerResult = await routeGuardianReply({
      messageText: trimmedContent,
      channel: "vellum",
      actor: {
        actorPrincipalId:
          session.trustContext?.guardianPrincipalId ?? undefined,
        actorExternalUserId: session.trustContext?.guardianExternalUserId,
        channel: "vellum",
        guardianPrincipalId:
          session.trustContext?.guardianPrincipalId ?? undefined,
      },
      conversationId: session.conversationId,
      pendingRequestIds: canonicalPendingRequestIdsForConversation,
      // Desktop path: disable NL classification to avoid consuming non-decision
      // messages while a tool confirmation is pending. Deterministic code-prefix
      // and callback parsing remain active.
      approvalConversationGenerator: undefined,
    });

    if (routerResult.consumed) {
      const guardianIfCtx = session.getTurnInterfaceContext();
      const routerChannelMeta = {
        userMessageChannel: "vellum" as const,
        assistantMessageChannel: "vellum" as const,
        userMessageInterface: guardianIfCtx?.userMessageInterface ?? "vellum",
        assistantMessageInterface:
          guardianIfCtx?.assistantMessageInterface ?? "vellum",
        provenanceTrustClass: "guardian" as const,
      };

      const userMsg = createUserMessage(content, attachments);
      const persisted = await conversationStore.addMessage(
        session.conversationId,
        "user",
        JSON.stringify(userMsg.content),
        routerChannelMeta,
      );
      session.messages.push(userMsg);

      const replyText =
        routerResult.replyText ??
        (routerResult.decisionApplied
          ? "Decision applied."
          : "Request already resolved.");
      const assistantMsg = createAssistantMessage(replyText);
      await conversationStore.addMessage(
        session.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        routerChannelMeta,
      );
      session.messages.push(assistantMsg);

      onEvent({ type: "assistant_text_delta", text: replyText });
      onEvent({ type: "message_complete", sessionId: session.conversationId });

      log.info(
        {
          conversationId: session.conversationId,
          routerType: routerResult.type,
          requestId: routerResult.requestId,
        },
        "Session guardian reply routed through canonical pipeline",
      );

      return persisted.id;
    }
  }

  // Resolve slash commands before persistence
  const slashResult = resolveSlash(content, buildSlashContext(session));

  // Unknown slash command — persist the exchange (user + assistant) so the
  // messageId is real.  Persist each message before pushing to session.messages
  // so that a failed write never leaves an unpersisted message in memory.
  if (slashResult.kind === "unknown") {
    const pmTurnCtx = session.getTurnChannelContext();
    const pmInterfaceCtx = session.getTurnInterfaceContext();
    const pmProvenance = provenanceFromTrustContext(session.trustContext);
    const pmChannelMeta = {
      ...pmProvenance,
      ...(pmTurnCtx
        ? {
            userMessageChannel: pmTurnCtx.userMessageChannel,
            assistantMessageChannel: pmTurnCtx.assistantMessageChannel,
          }
        : {}),
      ...(pmInterfaceCtx
        ? {
            userMessageInterface: pmInterfaceCtx.userMessageInterface,
            assistantMessageInterface: pmInterfaceCtx.assistantMessageInterface,
          }
        : {}),
    };
    const userMsg = createUserMessage(content, attachments);
    // When displayContent is provided (e.g. original text before recording
    // intent stripping), persist that to DB so users see the full message.
    // The in-memory userMessage (sent to the LLM) still uses the stripped content.
    const contentToPersist = displayContent
      ? JSON.stringify(createUserMessage(displayContent, attachments).content)
      : JSON.stringify(userMsg.content);
    const persisted = await conversationStore.addMessage(
      session.conversationId,
      "user",
      contentToPersist,
      pmChannelMeta,
    );
    session.messages.push(userMsg);

    const assistantMsg = createAssistantMessage(slashResult.message);
    await conversationStore.addMessage(
      session.conversationId,
      "assistant",
      JSON.stringify(assistantMsg.content),
      pmChannelMeta,
    );
    session.messages.push(assistantMsg);

    if (pmTurnCtx) {
      conversationStore.setConversationOriginChannelIfUnset(
        session.conversationId,
        pmTurnCtx.userMessageChannel,
      );
    }
    if (pmInterfaceCtx) {
      conversationStore.setConversationOriginInterfaceIfUnset(
        session.conversationId,
        pmInterfaceCtx.userMessageInterface,
      );
    }

    // Emit fresh model info before the text delta so the client has
    // up-to-date configuredProviders when rendering /model or /models UI.
    if (isModelSlashCommand(content)) {
      onEvent(buildModelInfoEvent());
    }
    onEvent({ type: "assistant_text_delta", text: slashResult.message });
    session.traceEmitter.emit(
      "message_complete",
      "Unknown slash command handled",
      {
        requestId,
        status: "success",
      },
    );
    onEvent({ type: "message_complete", sessionId: session.conversationId });
    return persisted.id;
  }

  const resolvedContent = slashResult.content;

  // Preactivate skill tools when slash resolution identifies a known skill
  if (slashResult.kind === "rewritten") {
    session.preactivatedSkillIds = [slashResult.skillId];
  }

  // Guardian verification intent interception — force direct guardian
  // verification requests into the guardian-verify-setup skill flow on
  // the first turn, avoiding conceptual preambles from the agent.
  // We keep the original user content for persistence and use the
  // rewritten content only for the agent loop instruction.
  let agentLoopContent = resolvedContent;
  if (slashResult.kind === "passthrough") {
    const guardianIntent = resolveGuardianVerificationIntent(resolvedContent);
    if (guardianIntent.kind === "direct_setup") {
      log.info(
        {
          conversationId: session.conversationId,
          channelHint: guardianIntent.channelHint,
        },
        "Guardian verification intent intercepted — forcing skill flow",
      );
      agentLoopContent = guardianIntent.rewrittenContent;
      session.preactivatedSkillIds = ["guardian-verify-setup"];
    }
  }

  let userMessageId: string;
  try {
    userMessageId = await session.persistUserMessage(
      resolvedContent,
      attachments,
      requestId,
      undefined,
      displayContent,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent({ type: "error", message });
    // runAgentLoop never ran, so its finally block won't clear this
    session.preactivatedSkillIds = undefined;
    return "";
  }

  // Fire-and-forget: detect notification preferences in the user message
  // and persist any that are found. Runs in the background so it doesn't
  // block the main conversation flow.
  if (session.assistantId) {
    const aid = session.assistantId;
    extractPreferences(resolvedContent)
      .then((result) => {
        if (!result.detected) return;
        for (const pref of result.preferences) {
          createPreference({
            assistantId: aid,
            preferenceText: pref.preferenceText,
            appliesWhen: pref.appliesWhen,
            priority: pref.priority,
          });
        }
        log.info(
          {
            count: result.preferences.length,
            conversationId: session.conversationId,
          },
          "Persisted extracted notification preferences",
        );
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          { err: errMsg, conversationId: session.conversationId },
          "Background preference extraction failed",
        );
      });
  }

  const loopOptions: {
    isInteractive?: boolean;
    isUserMessage?: boolean;
    titleText?: string;
  } = { isUserMessage: true };
  if (options?.isInteractive !== undefined)
    loopOptions.isInteractive = options.isInteractive;
  if (agentLoopContent !== resolvedContent)
    loopOptions.titleText = resolvedContent;

  await session.runAgentLoop(
    agentLoopContent,
    userMessageId,
    onEvent,
    loopOptions,
  );
  return userMessageId;
}
