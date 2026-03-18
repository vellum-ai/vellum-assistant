/**
 * Queue drain and message processing logic extracted from Conversation.
 *
 * Conversation delegates `drainQueue` and `processMessage` to the module-level
 * functions exported here, following the same context-interface pattern
 * used by conversation-history.ts.
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
import {
  addMessage,
  provenanceFromTrustContext,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
} from "../memory/conversation-crud.js";
import { extractPreferences } from "../notifications/preference-extractor.js";
import { createPreference } from "../notifications/preferences-store.js";
import { PROVIDER_MODEL_CATALOG } from "../providers/model-catalog.js";
import { getConfiguredProviders } from "../providers/provider-availability.js";
import type { Message } from "../providers/types.js";
import { routeGuardianReply } from "../runtime/guardian-reply-router.js";
import { getLogger } from "../util/logger.js";
import type { MessageQueue } from "./conversation-queue-manager.js";
import type { QueueDrainReason } from "./conversation-queue-manager.js";
import type { TrustContext } from "./conversation-runtime-assembly.js";
import {
  isProviderShortcut,
  resolveSlash,
  type SlashContext,
} from "./conversation-slash.js";
import type { ModelSetContext } from "./handlers/config-model.js";
import type {
  ServerMessage,
  UsageStats,
  UserMessageAttachment,
} from "./message-protocol.js";
import type { TraceEmitter } from "./trace-emitter.js";
import { resolveVerificationSessionIntent } from "./verification-session-intent.js";

const log = getLogger("conversation-process");

/** Build a model_info event with fresh config data. */
export async function buildModelInfoEvent(): Promise<ServerMessage> {
  const config = getConfig();
  const provider = config.services.inference.provider;
  return {
    type: "model_info",
    model: config.services.inference.model,
    provider,
    configuredProviders: await getConfiguredProviders(),
    availableModels: PROVIDER_MODEL_CATALOG[provider],
  };
}

/** True when the trimmed content is a /model or /models slash command. */
export function isModelSlashCommand(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed === "/model" ||
    trimmed === "/models" ||
    trimmed.startsWith("/model ")
  );
}

// ── Context Interface ────────────────────────────────────────────────

/**
 * Subset of Conversation state that drainQueue / processMessage need access to.
 * The Conversation class implements this interface so its instances can be
 * passed directly to the extracted functions.
 */
export interface ProcessConversationContext {
  readonly conversationId: string;
  messages: Message[];
  processing: boolean;
  abortController: AbortController | null;
  currentRequestId?: string;
  readonly queue: MessageQueue;
  readonly traceEmitter: TraceEmitter;
  currentActiveSurfaceId?: string;
  currentPage?: string;
  /** Cumulative token usage stats for the conversation. */
  readonly usageStats: UsageStats;
  /** Request-scoped skill IDs preactivated via config or programmatic injection. */
  preactivatedSkillIds?: string[];
  /** Add a skill ID to the preactivated set without replacing existing entries. */
  addPreactivatedSkillId(id: string): void;
  /** Assistant identity — used for scoping notification preferences. */
  readonly assistantId?: string;
  /** Model set context for delegating model/provider changes through shared setModel(). */
  modelSetContext?: ModelSetContext;
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
  /** Mark host proxies as unavailable so tool execution uses local fallback. */
  clearProxyAvailability(): void;
  /** Restore host proxy availability based on whether a real client is connected. */
  restoreProxyAvailability(): void;
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
      | "error_terminal"
      | "preview_start"
      | "context_compacting",
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

/** Build a SlashContext from the current conversation state and config. */
function buildSlashContext(
  conversation: ProcessConversationContext,
): SlashContext {
  const config = getConfig();
  return {
    messageCount: conversation.messages.length,
    inputTokens: conversation.usageStats.inputTokens,
    outputTokens: conversation.usageStats.outputTokens,
    maxInputTokens: config.contextWindow.maxInputTokens,
    model: config.services.inference.model,
    provider: config.services.inference.provider,
    estimatedCost: conversation.usageStats.estimatedCost,
    modelSetContext: conversation.modelSetContext,
  };
}

// ── drainQueue ───────────────────────────────────────────────────────

/**
 * Process the next message in the queue, if any.
 * Called from the `runAgentLoop` finally block after processing completes.
 *
 * When a dequeued message fails to persist (e.g. empty content, DB error),
 * `processMessage` catches the error and resolves without calling
 * `runAgentLoop`. Since the drain chain depends on `runAgentLoop`'s `finally`
 * block, we must explicitly continue draining on failure — otherwise
 * remaining queued messages would be stranded.
 */
export async function drainQueue(
  conversation: ProcessConversationContext,
  reason: QueueDrainReason = "loop_complete",
): Promise<void> {
  const next = conversation.queue.shift();
  if (!next) return;

  // Reset per-turn preactivation so a prior iteration (e.g. an unknown-slash
  // from a desktop source that skips runAgentLoop) can't leak CU preactivation
  // into the next queued message.
  conversation.preactivatedSkillIds = undefined;

  log.info(
    {
      conversationId: conversation.conversationId,
      requestId: next.requestId,
      reason,
    },
    "Dequeuing message",
  );
  conversation.traceEmitter.emit(
    "request_dequeued",
    `Message dequeued (${reason})`,
    {
      requestId: next.requestId,
      status: "info",
      attributes: { reason },
    },
  );
  next.onEvent({
    type: "message_dequeued",
    conversationId: conversation.conversationId,
    requestId: next.requestId,
  });
  conversation.emitActivityState(
    "thinking",
    "message_dequeued",
    "assistant_turn",
    next.requestId,
  );

  const queuedTurnCtx = resolveQueuedTurnContext(
    next,
    conversation.getTurnChannelContext(),
  );
  if (queuedTurnCtx) {
    conversation.setTurnChannelContext(queuedTurnCtx);
  }

  const queuedInterfaceCtx = resolveQueuedTurnInterfaceContext(
    next,
    conversation.getTurnInterfaceContext(),
  );
  if (queuedInterfaceCtx) {
    conversation.setTurnInterfaceContext(queuedInterfaceCtx);
  }

  // Non-interactive queued messages (channel requests) must not execute tools
  // via the desktop host proxy. Clear proxy availability so isAvailable()
  // returns false and tool execution falls back to local.
  if (next.isInteractive === false) {
    conversation.clearProxyAvailability();
  } else {
    // Restore proxy availability only for desktop-originating turns (macos/ios)
    // in case a prior non-interactive drain disabled it. Non-desktop interactive
    // interfaces (CLI, Vellum) should not re-enable desktop host proxies.
    const interfaceCtx =
      queuedInterfaceCtx ?? conversation.getTurnInterfaceContext();
    const sourceInterface = interfaceCtx?.userMessageInterface;
    if (sourceInterface === "macos" || sourceInterface === "ios") {
      conversation.restoreProxyAvailability();
      conversation.addPreactivatedSkillId("computer-use");
    }
  }

  // Resolve slash commands for queued messages
  const slashResult = await resolveSlash(
    next.content,
    buildSlashContext(conversation),
  );

  // Unknown slash — persist the exchange and continue draining.
  // Persist each message before pushing to conversation.messages so that a
  // failed write never leaves an unpersisted message in memory.
  if (slashResult.kind === "unknown") {
    try {
      const drainProvenance = provenanceFromTrustContext(
        conversation.trustContext,
      );
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
        ...(next.metadata?.automated ? { automated: true } : {}),
      };
      const userMsg = createUserMessage(next.content, next.attachments);
      // When displayContent is provided (e.g. original text before recording
      // intent stripping), persist that to DB so users see the full message.
      // The in-memory userMessage (sent to the LLM) still uses the stripped content.
      const contentToPersist = next.displayContent
        ? JSON.stringify(
            createUserMessage(next.displayContent, next.attachments).content,
          )
        : JSON.stringify(userMsg.content);
      await addMessage(
        conversation.conversationId,
        "user",
        contentToPersist,
        drainChannelMeta,
      );
      conversation.messages.push(userMsg);

      const assistantMsg = createAssistantMessage(slashResult.message);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        drainChannelMeta,
      );
      conversation.messages.push(assistantMsg);

      if (queuedTurnCtx) {
        setConversationOriginChannelIfUnset(
          conversation.conversationId,
          queuedTurnCtx.userMessageChannel,
        );
      }
      if (queuedInterfaceCtx) {
        setConversationOriginInterfaceIfUnset(
          conversation.conversationId,
          queuedInterfaceCtx.userMessageInterface,
        );
      }

      // Emit fresh model info before the text delta so the client has
      // up-to-date configuredProviders when rendering /model or /models UI.
      if (
        isModelSlashCommand(next.content) ||
        isProviderShortcut(next.content)
      ) {
        next.onEvent(await buildModelInfoEvent());
      }
      next.onEvent({ type: "assistant_text_delta", text: slashResult.message });
      conversation.traceEmitter.emit(
        "message_complete",
        "Unknown slash command handled",
        {
          requestId: next.requestId,
          status: "success",
        },
      );
      next.onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: next.requestId,
        },
        "Failed to persist unknown-slash exchange",
      );
      conversation.traceEmitter.emit(
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
    // Continue draining regardless of success/failure
    await drainQueue(conversation);
    return;
  }

  const resolvedContent = slashResult.content;

  // Guardian verification intent interception for queued messages.
  // Preserve the original user content for persistence; only the agent
  // loop receives the rewritten instruction.
  let agentLoopContent = resolvedContent;
  if (slashResult.kind === "passthrough") {
    const verificationIntent =
      resolveVerificationSessionIntent(resolvedContent);
    if (verificationIntent.kind === "direct_setup") {
      log.info(
        {
          conversationId: conversation.conversationId,
          channelHint: verificationIntent.channelHint,
        },
        "Verification session intent intercepted in queue — forcing skill flow",
      );
      agentLoopContent = verificationIntent.rewrittenContent;
      conversation.preactivatedSkillIds = ["guardian-verify-setup"];
    }
  }

  // Try to persist and run the dequeued message. If persistUserMessage
  // succeeds, runAgentLoop is called and its finally block will drain
  // the next message. If persistUserMessage fails, processMessage
  // resolves early (no runAgentLoop call), so we must continue draining.
  let userMessageId: string;
  try {
    userMessageId = await conversation.persistUserMessage(
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
        conversationId: conversation.conversationId,
        requestId: next.requestId,
      },
      "Failed to persist queued message",
    );
    conversation.traceEmitter.emit(
      "request_error",
      `Queued message persist failed: ${message}`,
      {
        requestId: next.requestId,
        status: "error",
        attributes: { reason: "persist_failure" },
      },
    );
    next.onEvent({ type: "error", message });
    // runAgentLoop never ran, so its finally block won't clear this
    conversation.preactivatedSkillIds = undefined;
    // Continue draining — don't strand remaining messages
    await drainQueue(conversation);
    return;
  }

  // Set the active surface for the dequeued message so runAgentLoop can inject context
  conversation.currentActiveSurfaceId = next.activeSurfaceId;
  conversation.currentPage = next.currentPage;

  // Fire-and-forget: detect notification preferences in the queued message
  // and persist any that are found, mirroring the logic in processMessage.
  if (conversation.assistantId) {
    extractPreferences(resolvedContent)
      .then((result) => {
        if (!result.detected) return;
        for (const pref of result.preferences) {
          createPreference({
            preferenceText: pref.preferenceText,
            appliesWhen: pref.appliesWhen,
            priority: pref.priority,
          });
        }
        log.info(
          {
            count: result.preferences.length,
            conversationId: conversation.conversationId,
          },
          "Persisted extracted notification preferences (queued)",
        );
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          { err: errMsg, conversationId: conversation.conversationId },
          "Background preference extraction failed (queued)",
        );
      });
  }

  // Fire-and-forget: persistUserMessage set conversation.processing = true
  // so subsequent messages will still be enqueued.
  // runAgentLoop's finally block will call drainQueue when this run completes.
  const drainLoopOptions: {
    isInteractive?: boolean;
    isUserMessage?: boolean;
    titleText?: string;
  } = { isUserMessage: true };
  if (next.isInteractive !== undefined)
    drainLoopOptions.isInteractive = next.isInteractive;
  if (agentLoopContent !== resolvedContent)
    drainLoopOptions.titleText = resolvedContent;

  conversation
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
          conversationId: conversation.conversationId,
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

// ── processMessage ───────────────────────────────────────────────────

/**
 * Convenience function that persists a user message and runs the agent loop
 * in a single call. Used by the message-handler path where blocking is expected.
 */
export async function processMessage(
  conversation: ProcessConversationContext,
  content: string,
  attachments: UserMessageAttachment[],
  onEvent: (msg: ServerMessage) => void,
  requestId?: string,
  activeSurfaceId?: string,
  currentPage?: string,
  options?: { isInteractive?: boolean },
  displayContent?: string,
): Promise<string> {
  await conversation.ensureActorScopedHistory();
  conversation.currentActiveSurfaceId = activeSurfaceId;
  conversation.currentPage = currentPage;
  const trimmedContent = content.trim();
  const canonicalPendingRequestHintIdsForConversation =
    trimmedContent.length > 0
      ? listPendingRequestsByConversationScope(
          conversation.conversationId,
          "vellum",
        ).map((request) => request.id)
      : [];
  const canonicalPendingRequestIdsForConversation =
    canonicalPendingRequestHintIdsForConversation.length > 0
      ? canonicalPendingRequestHintIdsForConversation
      : undefined;

  // ── Canonical guardian reply router (desktop/conversation path) ──
  // Desktop/conversation guardian replies are canonical-only. Messages consumed
  // by the router never hit the general agent loop.
  if (trimmedContent.length > 0) {
    const routerResult = await routeGuardianReply({
      messageText: trimmedContent,
      channel: "vellum",
      actor: {
        actorPrincipalId:
          conversation.trustContext?.guardianPrincipalId ?? undefined,
        actorExternalUserId: conversation.trustContext?.guardianExternalUserId,
        channel: "vellum",
        guardianPrincipalId:
          conversation.trustContext?.guardianPrincipalId ?? undefined,
      },
      conversationId: conversation.conversationId,
      pendingRequestIds: canonicalPendingRequestIdsForConversation,
      // Desktop path: disable NL classification to avoid consuming non-decision
      // messages while a tool confirmation is pending. Deterministic code-prefix
      // and callback parsing remain active.
      approvalConversationGenerator: undefined,
    });

    if (routerResult.consumed) {
      const guardianIfCtx = conversation.getTurnInterfaceContext();
      const routerChannelMeta = {
        userMessageChannel: "vellum" as const,
        assistantMessageChannel: "vellum" as const,
        userMessageInterface: guardianIfCtx?.userMessageInterface ?? "vellum",
        assistantMessageInterface:
          guardianIfCtx?.assistantMessageInterface ?? "vellum",
        provenanceTrustClass: "guardian" as const,
      };

      const userMsg = createUserMessage(content, attachments);
      const persisted = await addMessage(
        conversation.conversationId,
        "user",
        JSON.stringify(userMsg.content),
        routerChannelMeta,
      );
      conversation.messages.push(userMsg);

      const replyText =
        routerResult.replyText ??
        (routerResult.decisionApplied
          ? "Decision applied."
          : "Request already resolved.");
      const assistantMsg = createAssistantMessage(replyText);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        routerChannelMeta,
      );
      conversation.messages.push(assistantMsg);

      onEvent({ type: "assistant_text_delta", text: replyText });
      onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });

      log.info(
        {
          conversationId: conversation.conversationId,
          routerType: routerResult.type,
          requestId: routerResult.requestId,
        },
        "Conversation guardian reply routed through canonical pipeline",
      );

      return persisted.id;
    }
  }

  // Resolve slash commands before persistence
  const slashResult = await resolveSlash(
    content,
    buildSlashContext(conversation),
  );

  // Unknown slash command — persist the exchange (user + assistant) so the
  // messageId is real.  Persist each message before pushing to conversation.messages
  // so that a failed write never leaves an unpersisted message in memory.
  if (slashResult.kind === "unknown") {
    const pmTurnCtx = conversation.getTurnChannelContext();
    const pmInterfaceCtx = conversation.getTurnInterfaceContext();
    const pmProvenance = provenanceFromTrustContext(conversation.trustContext);
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
    const persisted = await addMessage(
      conversation.conversationId,
      "user",
      contentToPersist,
      pmChannelMeta,
    );
    conversation.messages.push(userMsg);

    const assistantMsg = createAssistantMessage(slashResult.message);
    await addMessage(
      conversation.conversationId,
      "assistant",
      JSON.stringify(assistantMsg.content),
      pmChannelMeta,
    );
    conversation.messages.push(assistantMsg);

    if (pmTurnCtx) {
      setConversationOriginChannelIfUnset(
        conversation.conversationId,
        pmTurnCtx.userMessageChannel,
      );
    }
    if (pmInterfaceCtx) {
      setConversationOriginInterfaceIfUnset(
        conversation.conversationId,
        pmInterfaceCtx.userMessageInterface,
      );
    }

    // Emit fresh model info before the text delta so the client has
    // up-to-date configuredProviders when rendering /model or /models UI.
    if (isModelSlashCommand(content) || isProviderShortcut(content)) {
      onEvent(await buildModelInfoEvent());
    }
    onEvent({ type: "assistant_text_delta", text: slashResult.message });
    conversation.traceEmitter.emit(
      "message_complete",
      "Unknown slash command handled",
      {
        requestId,
        status: "success",
      },
    );
    onEvent({
      type: "message_complete",
      conversationId: conversation.conversationId,
    });
    return persisted.id;
  }

  const resolvedContent = slashResult.content;

  // Guardian verification intent interception — force direct guardian
  // verification requests into the guardian-verify-setup skill flow on
  // the first turn, avoiding conceptual preambles from the agent.
  // We keep the original user content for persistence and use the
  // rewritten content only for the agent loop instruction.
  let agentLoopContent = resolvedContent;
  if (slashResult.kind === "passthrough") {
    const verificationIntent =
      resolveVerificationSessionIntent(resolvedContent);
    if (verificationIntent.kind === "direct_setup") {
      log.info(
        {
          conversationId: conversation.conversationId,
          channelHint: verificationIntent.channelHint,
        },
        "Verification session intent intercepted — forcing skill flow",
      );
      agentLoopContent = verificationIntent.rewrittenContent;
      conversation.preactivatedSkillIds = ["guardian-verify-setup"];
    }
  }

  let userMessageId: string;
  try {
    userMessageId = await conversation.persistUserMessage(
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
    conversation.preactivatedSkillIds = undefined;
    return "";
  }

  // Fire-and-forget: detect notification preferences in the user message
  // and persist any that are found. Runs in the background so it doesn't
  // block the main conversation flow.
  if (conversation.assistantId) {
    extractPreferences(resolvedContent)
      .then((result) => {
        if (!result.detected) return;
        for (const pref of result.preferences) {
          createPreference({
            preferenceText: pref.preferenceText,
            appliesWhen: pref.appliesWhen,
            priority: pref.priority,
          });
        }
        log.info(
          {
            count: result.preferences.length,
            conversationId: conversation.conversationId,
          },
          "Persisted extracted notification preferences",
        );
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          { err: errMsg, conversationId: conversation.conversationId },
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

  await conversation.runAgentLoop(
    agentLoopContent,
    userMessageId,
    onEvent,
    loopOptions,
  );
  return userMessageId;
}
