/**
 * Queue drain and message processing logic extracted from Session.
 *
 * Session delegates `drainQueue` and `processMessage` to the module-level
 * functions exported here, following the same context-interface pattern
 * used by session-history.ts.
 */

import { createAssistantMessage,createUserMessage } from '../agent/message-types.js';
import { answerCall } from '../calls/call-domain.js';
import type { TurnChannelContext, TurnInterfaceContext } from '../channels/types.js';
import { parseChannelId, parseInterfaceId } from '../channels/types.js';
import { getConfig } from '../config/loader.js';
import * as conversationStore from '../memory/conversation-store.js';
import { provenanceFromGuardianContext } from '../memory/conversation-store.js';
import {
  finalizeFollowup,
  getExpiredDeliveryByConversation,
  getFollowupDeliveryByConversation,
  getGuardianActionRequest,
  getPendingDeliveryByConversation,
  progressFollowupState,
  resolveGuardianActionRequest,
  startFollowupFromExpiredRequest,
} from '../memory/guardian-action-store.js';
import { processGuardianFollowUpTurn } from '../runtime/guardian-action-conversation-turn.js';
import { executeFollowupAction } from '../runtime/guardian-action-followup-executor.js';
import { composeGuardianActionMessageGenerative } from '../runtime/guardian-action-message-composer.js';
import type { GuardianActionCopyGenerator, GuardianFollowUpConversationGenerator } from '../runtime/http-types.js';
import { extractPreferences } from '../notifications/preference-extractor.js';
import { createPreference } from '../notifications/preferences-store.js';
import type { Message } from '../providers/types.js';
import { getLogger } from '../util/logger.js';
import { resolveGuardianVerificationIntent } from './guardian-verification-intent.js';
import type { UsageStats } from './ipc-contract.js';
import type { ServerMessage, UserMessageAttachment } from './ipc-protocol.js';
import type { MessageQueue } from './session-queue-manager.js';
import type { QueueDrainReason } from './session-queue-manager.js';
import type { GuardianRuntimeContext } from './session-runtime-assembly.js';
import { resolveSlash, type SlashContext } from './session-slash.js';
import type { TraceEmitter } from './trace-emitter.js';

const log = getLogger('session-process');

// ---------------------------------------------------------------------------
// Module-level generator injection
// ---------------------------------------------------------------------------
// The daemon lifecycle creates the generator once and injects it here so the
// mac/IPC channel path can classify follow-up replies without threading the
// generator through Session / DaemonServer constructors.
let _guardianFollowUpGenerator: GuardianFollowUpConversationGenerator | undefined;
let _guardianActionCopyGenerator: GuardianActionCopyGenerator | undefined;

/** Inject the guardian follow-up conversation generator (called from lifecycle.ts). */
export function setGuardianFollowUpConversationGenerator(gen: GuardianFollowUpConversationGenerator): void {
  _guardianFollowUpGenerator = gen;
}

/** Inject the guardian action copy generator (called from lifecycle.ts). */
export function setGuardianActionCopyGenerator(gen: GuardianActionCopyGenerator): void {
  _guardianActionCopyGenerator = gen;
}

/** Build a model_info event with fresh config data. */
function buildModelInfoEvent(): ServerMessage {
  const config = getConfig();
  const configured = Object.keys(config.apiKeys).filter((k) => !!config.apiKeys[k]);
  if (!configured.includes('ollama')) configured.push('ollama');
  return {
    type: 'model_info',
    model: config.model,
    provider: config.provider,
    configuredProviders: configured,
  };
}

/** True when the trimmed content is a /model or /models slash command. */
function isModelSlashCommand(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === '/model' || trimmed === '/models' || trimmed.startsWith('/model ');
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
  guardianContext?: GuardianRuntimeContext;
  persistUserMessage(content: string, attachments: UserMessageAttachment[], requestId?: string, metadata?: Record<string, unknown>, displayContent?: string): string;
  runAgentLoop(
    content: string,
    userMessageId: string,
    onEvent: (msg: ServerMessage) => void,
    options?: { skipPreMessageRollback?: boolean; isInteractive?: boolean },
  ): Promise<void>;
  getTurnChannelContext(): TurnChannelContext | null;
  setTurnChannelContext(ctx: TurnChannelContext): void;
  getTurnInterfaceContext(): TurnInterfaceContext | null;
  setTurnInterfaceContext(ctx: TurnInterfaceContext): void;
}

function resolveQueuedTurnContext(
  queued: { turnChannelContext?: TurnChannelContext; metadata?: Record<string, unknown> },
  fallback: TurnChannelContext | null,
): TurnChannelContext | null {
  if (queued.turnChannelContext) return queued.turnChannelContext;
  const metadata = queued.metadata;
  if (metadata) {
    const userMessageChannel = parseChannelId(metadata.userMessageChannel);
    const assistantMessageChannel = parseChannelId(metadata.assistantMessageChannel);
    if (userMessageChannel && assistantMessageChannel) {
      return { userMessageChannel, assistantMessageChannel };
    }
  }
  return fallback;
}

function resolveQueuedTurnInterfaceContext(
  queued: { turnInterfaceContext?: TurnInterfaceContext; metadata?: Record<string, unknown> },
  fallback: TurnInterfaceContext | null,
): TurnInterfaceContext | null {
  if (queued.turnInterfaceContext) return queued.turnInterfaceContext;
  const metadata = queued.metadata;
  if (metadata) {
    const userMessageInterface = parseInterfaceId(metadata.userMessageInterface);
    const assistantMessageInterface = parseInterfaceId(metadata.assistantMessageInterface);
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
 * Process the next message in the queue, if any.
 * Called from the `runAgentLoop` finally block after processing completes.
 *
 * When a dequeued message fails to persist (e.g. empty content, DB error),
 * `processMessage` catches the error and resolves without calling
 * `runAgentLoop`. Since the drain chain depends on `runAgentLoop`'s `finally`
 * block, we must explicitly continue draining on failure — otherwise
 * remaining queued messages would be stranded.
 */
export function drainQueue(session: ProcessSessionContext, reason: QueueDrainReason = 'loop_complete'): void {
  const next = session.queue.shift();
  if (!next) return;

  log.info({ conversationId: session.conversationId, requestId: next.requestId, reason }, 'Dequeuing message');
  session.traceEmitter.emit('request_dequeued', `Message dequeued (${reason})`, {
    requestId: next.requestId,
    status: 'info',
    attributes: { reason },
  });
  next.onEvent({
    type: 'message_dequeued',
    sessionId: session.conversationId,
    requestId: next.requestId,
  });

  const queuedTurnCtx = resolveQueuedTurnContext(next, session.getTurnChannelContext());
  if (queuedTurnCtx) {
    session.setTurnChannelContext(queuedTurnCtx);
  }

  const queuedInterfaceCtx = resolveQueuedTurnInterfaceContext(next, session.getTurnInterfaceContext());
  if (queuedInterfaceCtx) {
    session.setTurnInterfaceContext(queuedInterfaceCtx);
  }

  // Resolve slash commands for queued messages
  const slashResult = resolveSlash(next.content, buildSlashContext(session));

  // Unknown slash — persist the exchange and continue draining.
  // Persist each message before pushing to session.messages so that a
  // failed write never leaves an unpersisted message in memory.
  if (slashResult.kind === 'unknown') {
    try {
      const drainProvenance = provenanceFromGuardianContext(session.guardianContext);
      const drainChannelMeta = {
        ...drainProvenance,
        ...(queuedTurnCtx
          ? { userMessageChannel: queuedTurnCtx.userMessageChannel, assistantMessageChannel: queuedTurnCtx.assistantMessageChannel }
          : {}),
        ...(queuedInterfaceCtx
          ? { userMessageInterface: queuedInterfaceCtx.userMessageInterface, assistantMessageInterface: queuedInterfaceCtx.assistantMessageInterface }
          : {}),
      };
      const userMsg = createUserMessage(next.content, next.attachments);
      // When displayContent is provided (e.g. original text before recording
      // intent stripping), persist that to DB so users see the full message.
      // The in-memory userMessage (sent to the LLM) still uses the stripped content.
      const contentToPersist = next.displayContent
        ? JSON.stringify(createUserMessage(next.displayContent, next.attachments).content)
        : JSON.stringify(userMsg.content);
      conversationStore.addMessage(
        session.conversationId,
        'user',
        contentToPersist,
        drainChannelMeta,
      );
      session.messages.push(userMsg);

      const assistantMsg = createAssistantMessage(slashResult.message);
      conversationStore.addMessage(
        session.conversationId,
        'assistant',
        JSON.stringify(assistantMsg.content),
        drainChannelMeta,
      );
      session.messages.push(assistantMsg);

      if (queuedTurnCtx) {
        conversationStore.setConversationOriginChannelIfUnset(session.conversationId, queuedTurnCtx.userMessageChannel);
      }
      if (queuedInterfaceCtx) {
        conversationStore.setConversationOriginInterfaceIfUnset(session.conversationId, queuedInterfaceCtx.userMessageInterface);
      }

      // Emit fresh model info before the text delta so the client has
      // up-to-date configuredProviders when rendering /model or /models UI.
      if (isModelSlashCommand(next.content)) {
        next.onEvent(buildModelInfoEvent());
      }
      next.onEvent({ type: 'assistant_text_delta', text: slashResult.message });
      session.traceEmitter.emit('message_complete', 'Unknown slash command handled', {
        requestId: next.requestId,
        status: 'success',
      });
      next.onEvent({ type: 'message_complete', sessionId: session.conversationId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, conversationId: session.conversationId, requestId: next.requestId }, 'Failed to persist unknown-slash exchange');
      session.traceEmitter.emit('request_error', `Unknown-slash persist failed: ${message}`, {
        requestId: next.requestId,
        status: 'error',
        attributes: { reason: 'persist_failure' },
      });
      next.onEvent({ type: 'error', message });
    }
    // Continue draining regardless of success/failure
    drainQueue(session);
    return;
  }

  let resolvedContent = slashResult.content;

  // Preactivate skill tools when slash resolution identifies a known skill
  if (slashResult.kind === 'rewritten') {
    session.preactivatedSkillIds = [slashResult.skillId];
  }

  // Guardian verification intent interception for queued messages.
  // Preserve the original user content for persistence; only the agent
  // loop receives the rewritten instruction.
  let agentLoopContent = resolvedContent;
  if (slashResult.kind === 'passthrough') {
    const guardianIntent = resolveGuardianVerificationIntent(resolvedContent);
    if (guardianIntent.kind === 'direct_setup') {
      log.info({ conversationId: session.conversationId, channelHint: guardianIntent.channelHint }, 'Guardian verification intent intercepted in queue — forcing skill flow');
      agentLoopContent = guardianIntent.rewrittenContent;
      session.preactivatedSkillIds = ['guardian-verify-setup'];
    }
  }

  // Try to persist and run the dequeued message. If persistUserMessage
  // succeeds, runAgentLoop is called and its finally block will drain
  // the next message. If persistUserMessage fails, processMessage
  // resolves early (no runAgentLoop call), so we must continue draining.
  let userMessageId: string;
  try {
    userMessageId = session.persistUserMessage(resolvedContent, next.attachments, next.requestId, next.metadata, next.displayContent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, conversationId: session.conversationId, requestId: next.requestId }, 'Failed to persist queued message');
    session.traceEmitter.emit('request_error', `Queued message persist failed: ${message}`, {
      requestId: next.requestId,
      status: 'error',
      attributes: { reason: 'persist_failure' },
    });
    next.onEvent({ type: 'error', message });
    // runAgentLoop never ran, so its finally block won't clear this
    session.preactivatedSkillIds = undefined;
    // Continue draining — don't strand remaining messages
    drainQueue(session);
    return;
  }

  // Set the active surface for the dequeued message so runAgentLoop can inject context
  session.currentActiveSurfaceId = next.activeSurfaceId;
  session.currentPage = next.currentPage;

  // Fire-and-forget: detect notification preferences in the queued message
  // and persist any that are found, mirroring the logic in processMessage.
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
        log.info({ count: result.preferences.length, conversationId: session.conversationId }, 'Persisted extracted notification preferences (queued)');
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn({ err: errMsg, conversationId: session.conversationId }, 'Background preference extraction failed (queued)');
      });
  }

  // Fire-and-forget: persistUserMessage set session.processing = true
  // so subsequent messages will still be enqueued.
  // runAgentLoop's finally block will call drainQueue when this run completes.
  session.runAgentLoop(agentLoopContent, userMessageId, next.onEvent,
    next.isInteractive !== undefined ? { isInteractive: next.isInteractive } : undefined,
  ).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, conversationId: session.conversationId, requestId: next.requestId }, 'Error processing queued message');
    next.onEvent({ type: 'error', message: `Failed to process queued message: ${message}` });
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
  session.currentActiveSurfaceId = activeSurfaceId;
  session.currentPage = currentPage;

  // ── Guardian action answer interception (mac channel) ──
  // If this conversation has a pending guardian action delivery, treat the
  // user message as the guardian's answer instead of running the agent loop.
  const guardianDelivery = getPendingDeliveryByConversation(session.conversationId);
  if (guardianDelivery) {
    const guardianRequest = getGuardianActionRequest(guardianDelivery.requestId);
    if (guardianRequest && guardianRequest.status === 'pending') {
      const guardianIfCtx = session.getTurnInterfaceContext();
      const guardianChannelMeta = { userMessageChannel: 'vellum' as const, assistantMessageChannel: 'vellum' as const, userMessageInterface: guardianIfCtx?.userMessageInterface ?? 'vellum', assistantMessageInterface: guardianIfCtx?.assistantMessageInterface ?? 'vellum', provenanceActorRole: 'guardian' as const };
      const userMsg = createUserMessage(content, attachments);
      const persisted = conversationStore.addMessage(
        session.conversationId,
        'user',
        JSON.stringify(userMsg.content),
        guardianChannelMeta,
      );
      session.messages.push(userMsg);

      // Attempt to deliver the answer to the call first. Only resolve
      // the guardian action request if answerCall succeeds, so that a
      // failed delivery leaves the request pending for retry from
      // another channel.
      const answerResult = await answerCall({ callSessionId: guardianRequest.callSessionId, answer: content });

      if ('ok' in answerResult && answerResult.ok) {
        const resolved = resolveGuardianActionRequest(guardianRequest.id, content, 'vellum');
        const replyText = resolved
          ? 'Your answer has been relayed to the call.'
          : await composeGuardianActionMessageGenerative({ scenario: 'guardian_stale_answered' });
        const replyMsg = createAssistantMessage(replyText);
        conversationStore.addMessage(
          session.conversationId,
          'assistant',
          JSON.stringify(replyMsg.content),
          guardianChannelMeta,
        );
        session.messages.push(replyMsg);
        onEvent({ type: 'assistant_text_delta', text: replyText });
      } else {
        const errorDetail = 'error' in answerResult ? answerResult.error : 'Unknown error';
        log.warn({ callSessionId: guardianRequest.callSessionId, error: errorDetail }, 'answerCall failed for mac guardian answer');
        const failMsg = createAssistantMessage('Failed to deliver your answer to the call. Please try again.');
        conversationStore.addMessage(
          session.conversationId,
          'assistant',
          JSON.stringify(failMsg.content),
          guardianChannelMeta,
        );
        session.messages.push(failMsg);
        onEvent({ type: 'assistant_text_delta', text: 'Failed to deliver your answer to the call. Please try again.' });
      }
      onEvent({ type: 'message_complete', sessionId: session.conversationId });
      return persisted.id;
    }
  }

  // ── Expired guardian action late answer interception (mac channel) ──
  // If no pending delivery was found, check for expired requests eligible
  // for follow-up (status='expired', followup_state='none').
  const expiredDelivery = getExpiredDeliveryByConversation(session.conversationId);
  if (expiredDelivery) {
    const expiredRequest = getGuardianActionRequest(expiredDelivery.requestId);
    if (expiredRequest && expiredRequest.status === 'expired' && expiredRequest.followupState === 'none') {
      const guardianIfCtx = session.getTurnInterfaceContext();
      const guardianChannelMeta = { userMessageChannel: 'vellum' as const, assistantMessageChannel: 'vellum' as const, userMessageInterface: guardianIfCtx?.userMessageInterface ?? 'vellum', assistantMessageInterface: guardianIfCtx?.assistantMessageInterface ?? 'vellum', provenanceActorRole: 'guardian' as const };
      const userMsg = createUserMessage(content, attachments);
      const persisted = conversationStore.addMessage(
        session.conversationId,
        'user',
        JSON.stringify(userMsg.content),
        guardianChannelMeta,
      );
      session.messages.push(userMsg);

      const followupResult = startFollowupFromExpiredRequest(expiredRequest.id, content);
      if (followupResult) {
        // Use the composer without a generator — the daemon's mac path may not
        // have direct access to the provider-backed generator, so deterministic
        // fallback text is used.
        const followupText = await composeGuardianActionMessageGenerative(
          {
            scenario: 'guardian_late_answer_followup',
            questionText: expiredRequest.questionText,
            lateAnswerText: content,
          },
        );
        const replyMsg = createAssistantMessage(followupText);
        conversationStore.addMessage(
          session.conversationId,
          'assistant',
          JSON.stringify(replyMsg.content),
          guardianChannelMeta,
        );
        session.messages.push(replyMsg);
        onEvent({ type: 'assistant_text_delta', text: followupText });
      } else {
        // Follow-up already started or conflict — send stale message
        const staleText = await composeGuardianActionMessageGenerative(
          { scenario: 'guardian_stale_expired' },
        );
        const staleMsg = createAssistantMessage(staleText);
        conversationStore.addMessage(
          session.conversationId,
          'assistant',
          JSON.stringify(staleMsg.content),
          guardianChannelMeta,
        );
        session.messages.push(staleMsg);
        onEvent({ type: 'assistant_text_delta', text: staleText });
      }
      onEvent({ type: 'message_complete', sessionId: session.conversationId });
      return persisted.id;
    }
  }

  // ── Guardian follow-up conversation interception (mac channel) ──
  // When a request is in `awaiting_guardian_choice` state, the guardian has
  // already been asked "call back or send a message?". Their next message
  // is the reply — route it through the conversation engine.
  const followupDelivery = getFollowupDeliveryByConversation(session.conversationId);
  if (followupDelivery) {
    const followupRequest = getGuardianActionRequest(followupDelivery.requestId);
    if (followupRequest && followupRequest.followupState === 'awaiting_guardian_choice') {
      const guardianIfCtx = session.getTurnInterfaceContext();
      const guardianChannelMeta = { userMessageChannel: 'vellum' as const, assistantMessageChannel: 'vellum' as const, userMessageInterface: guardianIfCtx?.userMessageInterface ?? 'vellum', assistantMessageInterface: guardianIfCtx?.assistantMessageInterface ?? 'vellum', provenanceActorRole: 'guardian' as const };
      const userMsg = createUserMessage(content, attachments);
      const persisted = conversationStore.addMessage(
        session.conversationId,
        'user',
        JSON.stringify(userMsg.content),
        guardianChannelMeta,
      );
      session.messages.push(userMsg);

      const turnResult = await processGuardianFollowUpTurn(
        {
          questionText: followupRequest.questionText,
          lateAnswerText: followupRequest.lateAnswerText ?? '',
          guardianReply: content,
        },
        _guardianFollowUpGenerator,
      );

      // Apply the disposition to the follow-up state machine.
      // Both progressFollowupState and finalizeFollowup are compare-and-set:
      // they return null when the transition fails (e.g. a concurrent message
      // already advanced the state). In that case, send a stale notice instead
      // of the disposition-specific reply.
      let transitionApplied = true;
      if (turnResult.disposition === 'call_back' || turnResult.disposition === 'message_back') {
        transitionApplied = progressFollowupState(followupRequest.id, 'dispatching', turnResult.disposition) !== null;
      } else if (turnResult.disposition === 'decline') {
        transitionApplied = finalizeFollowup(followupRequest.id, 'declined') !== null;
      }
      // keep_pending: no state change — guardian can reply again

      const replyText = transitionApplied
        ? turnResult.replyText
        : await composeGuardianActionMessageGenerative({ scenario: 'guardian_stale_followup' });
      const replyMsg = createAssistantMessage(replyText);
      conversationStore.addMessage(
        session.conversationId,
        'assistant',
        JSON.stringify(replyMsg.content),
        guardianChannelMeta,
      );
      session.messages.push(replyMsg);
      onEvent({ type: 'assistant_text_delta', text: replyText });
      onEvent({ type: 'message_complete', sessionId: session.conversationId });

      // Execute the action and send a completion/failure message (fire-and-forget).
      // The initial reply above acknowledges the guardian's choice; the executor
      // carries out the actual call_back or message_back and posts a second message.
      if (transitionApplied && (turnResult.disposition === 'call_back' || turnResult.disposition === 'message_back')) {
        void (async () => {
          try {
            const execResult = await executeFollowupAction(
              followupRequest.id,
              turnResult.disposition as 'call_back' | 'message_back',
              _guardianActionCopyGenerator,
            );
            const completionMsg = createAssistantMessage(execResult.guardianReplyText);
            conversationStore.addMessage(
              session.conversationId,
              'assistant',
              JSON.stringify(completionMsg.content),
              guardianChannelMeta,
            );
            session.messages.push(completionMsg);
            onEvent({ type: 'assistant_text_delta', text: execResult.guardianReplyText });
            onEvent({ type: 'message_complete', sessionId: session.conversationId });
          } catch (execErr) {
            log.error({ err: execErr, requestId: followupRequest.id }, 'Follow-up action execution or completion message failed');
          }
        })();
      }

      return persisted.id;
    }
  }

  // Resolve slash commands before persistence
  const slashResult = resolveSlash(content, buildSlashContext(session));

  // Unknown slash command — persist the exchange (user + assistant) so the
  // messageId is real.  Persist each message before pushing to session.messages
  // so that a failed write never leaves an unpersisted message in memory.
  if (slashResult.kind === 'unknown') {
    const pmTurnCtx = session.getTurnChannelContext();
    const pmInterfaceCtx = session.getTurnInterfaceContext();
    const pmProvenance = provenanceFromGuardianContext(session.guardianContext);
    const pmChannelMeta = {
      ...pmProvenance,
      ...(pmTurnCtx
        ? { userMessageChannel: pmTurnCtx.userMessageChannel, assistantMessageChannel: pmTurnCtx.assistantMessageChannel }
        : {}),
      ...(pmInterfaceCtx
        ? { userMessageInterface: pmInterfaceCtx.userMessageInterface, assistantMessageInterface: pmInterfaceCtx.assistantMessageInterface }
        : {}),
    };
    const userMsg = createUserMessage(content, attachments);
    // When displayContent is provided (e.g. original text before recording
    // intent stripping), persist that to DB so users see the full message.
    // The in-memory userMessage (sent to the LLM) still uses the stripped content.
    const contentToPersist = displayContent
      ? JSON.stringify(createUserMessage(displayContent, attachments).content)
      : JSON.stringify(userMsg.content);
    const persisted = conversationStore.addMessage(
      session.conversationId,
      'user',
      contentToPersist,
      pmChannelMeta,
    );
    session.messages.push(userMsg);

    const assistantMsg = createAssistantMessage(slashResult.message);
    conversationStore.addMessage(
      session.conversationId,
      'assistant',
      JSON.stringify(assistantMsg.content),
      pmChannelMeta,
    );
    session.messages.push(assistantMsg);

    if (pmTurnCtx) {
      conversationStore.setConversationOriginChannelIfUnset(session.conversationId, pmTurnCtx.userMessageChannel);
    }
    if (pmInterfaceCtx) {
      conversationStore.setConversationOriginInterfaceIfUnset(session.conversationId, pmInterfaceCtx.userMessageInterface);
    }

    // Emit fresh model info before the text delta so the client has
    // up-to-date configuredProviders when rendering /model or /models UI.
    if (isModelSlashCommand(content)) {
      onEvent(buildModelInfoEvent());
    }
    onEvent({ type: 'assistant_text_delta', text: slashResult.message });
    session.traceEmitter.emit('message_complete', 'Unknown slash command handled', {
      requestId,
      status: 'success',
    });
    onEvent({ type: 'message_complete', sessionId: session.conversationId });
    return persisted.id;
  }

  let resolvedContent = slashResult.content;

  // Preactivate skill tools when slash resolution identifies a known skill
  if (slashResult.kind === 'rewritten') {
    session.preactivatedSkillIds = [slashResult.skillId];
  }

  // Guardian verification intent interception — force direct guardian
  // verification requests into the guardian-verify-setup skill flow on
  // the first turn, avoiding conceptual preambles from the agent.
  // We keep the original user content for persistence and use the
  // rewritten content only for the agent loop instruction.
  let agentLoopContent = resolvedContent;
  if (slashResult.kind === 'passthrough') {
    const guardianIntent = resolveGuardianVerificationIntent(resolvedContent);
    if (guardianIntent.kind === 'direct_setup') {
      log.info({ conversationId: session.conversationId, channelHint: guardianIntent.channelHint }, 'Guardian verification intent intercepted — forcing skill flow');
      agentLoopContent = guardianIntent.rewrittenContent;
      session.preactivatedSkillIds = ['guardian-verify-setup'];
    }
  }

  let userMessageId: string;
  try {
    userMessageId = session.persistUserMessage(resolvedContent, attachments, requestId, undefined, displayContent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent({ type: 'error', message });
    // runAgentLoop never ran, so its finally block won't clear this
    session.preactivatedSkillIds = undefined;
    return '';
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
        log.info({ count: result.preferences.length, conversationId: session.conversationId }, 'Persisted extracted notification preferences');
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn({ err: errMsg, conversationId: session.conversationId }, 'Background preference extraction failed');
      });
  }

  await session.runAgentLoop(agentLoopContent, userMessageId, onEvent,
    options?.isInteractive !== undefined ? { isInteractive: options.isInteractive } : undefined,
  );
  return userMessageId;
}
