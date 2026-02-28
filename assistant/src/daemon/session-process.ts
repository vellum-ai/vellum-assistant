/**
 * Queue drain and message processing logic extracted from Session.
 *
 * Session delegates `drainQueue` and `processMessage` to the module-level
 * functions exported here, following the same context-interface pattern
 * used by session-history.ts.
 */

import { createAssistantMessage,createUserMessage } from '../agent/message-types.js';
import { answerCall } from '../calls/call-domain.js';
import { isTerminalState } from '../calls/call-state-machine.js';
import { getCallSession } from '../calls/call-store.js';
import type { TurnChannelContext, TurnInterfaceContext } from '../channels/types.js';
import { parseChannelId, parseInterfaceId } from '../channels/types.js';
import { getConfig } from '../config/loader.js';
import { listPendingCanonicalGuardianRequestsByDestinationConversation } from '../memory/canonical-guardian-store.js';
import * as conversationStore from '../memory/conversation-store.js';
import { provenanceFromGuardianContext } from '../memory/conversation-store.js';
import {
  finalizeFollowup,
  getDeliveriesByRequestId,
  getExpiredDeliveriesByConversation,
  getFollowupDeliveriesByConversation,
  getGuardianActionRequest,
  getPendingDeliveriesByConversation,
  getPendingRequestByCallSessionId,
  progressFollowupState,
  resolveGuardianActionRequest,
  startFollowupFromExpiredRequest,
} from '../memory/guardian-action-store.js';
import { extractPreferences } from '../notifications/preference-extractor.js';
import { createPreference } from '../notifications/preferences-store.js';
import type { Message } from '../providers/types.js';
import { processGuardianFollowUpTurn } from '../runtime/guardian-action-conversation-turn.js';
import { executeFollowupAction } from '../runtime/guardian-action-followup-executor.js';
import { tryMintGuardianActionGrant } from '../runtime/guardian-action-grant-minter.js';
import { composeGuardianActionMessageGenerative } from '../runtime/guardian-action-message-composer.js';
import { routeGuardianReply } from '../runtime/guardian-reply-router.js';
import type { ApprovalConversationGenerator, GuardianActionCopyGenerator, GuardianFollowUpConversationGenerator } from '../runtime/http-types.js';
import { getLogger } from '../util/logger.js';
import { resolveGuardianInviteIntent } from './guardian-invite-intent.js';
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
let _approvalConversationGenerator: ApprovalConversationGenerator | undefined;

/** Inject the guardian follow-up conversation generator (called from lifecycle.ts). */
export function setGuardianFollowUpConversationGenerator(gen: GuardianFollowUpConversationGenerator): void {
  _guardianFollowUpGenerator = gen;
}

/** Inject the guardian action copy generator (called from lifecycle.ts). */
export function setGuardianActionCopyGenerator(gen: GuardianActionCopyGenerator): void {
  _guardianActionCopyGenerator = gen;
}

/** Inject the approval conversation generator (called from lifecycle.ts). */
export function setApprovalConversationGenerator(gen: ApprovalConversationGenerator): void {
  _approvalConversationGenerator = gen;
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
  ensureActorScopedHistory(): Promise<void>;
  persistUserMessage(content: string, attachments: UserMessageAttachment[], requestId?: string, metadata?: Record<string, unknown>, displayContent?: string): Promise<string>;
  runAgentLoop(
    content: string,
    userMessageId: string,
    onEvent: (msg: ServerMessage) => void,
    options?: { skipPreMessageRollback?: boolean; isInteractive?: boolean; titleText?: string },
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
export async function drainQueue(session: ProcessSessionContext, reason: QueueDrainReason = 'loop_complete'): Promise<void> {
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
      await conversationStore.addMessage(
        session.conversationId,
        'user',
        contentToPersist,
        drainChannelMeta,
      );
      session.messages.push(userMsg);

      const assistantMsg = createAssistantMessage(slashResult.message);
      await conversationStore.addMessage(
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
    await drainQueue(session);
    return;
  }

  const resolvedContent = slashResult.content;

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
    } else {
      // Guardian invite intent interception — force invite management
      // requests into the trusted-contacts skill flow.
      const inviteIntent = resolveGuardianInviteIntent(resolvedContent);
      if (inviteIntent.kind === 'invite_management') {
        log.info({ conversationId: session.conversationId, action: inviteIntent.action }, 'Guardian invite intent intercepted in queue — forcing skill flow');
        agentLoopContent = inviteIntent.rewrittenContent;
        session.preactivatedSkillIds = ['trusted-contacts'];
      }
    }
  }

  // Try to persist and run the dequeued message. If persistUserMessage
  // succeeds, runAgentLoop is called and its finally block will drain
  // the next message. If persistUserMessage fails, processMessage
  // resolves early (no runAgentLoop call), so we must continue draining.
  let userMessageId: string;
  try {
    userMessageId = await session.persistUserMessage(resolvedContent, next.attachments, next.requestId, next.metadata, next.displayContent);
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
    await drainQueue(session);
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
  const drainLoopOptions: { isInteractive?: boolean; titleText?: string } = {};
  if (next.isInteractive !== undefined) drainLoopOptions.isInteractive = next.isInteractive;
  if (agentLoopContent !== resolvedContent) drainLoopOptions.titleText = resolvedContent;

  session.runAgentLoop(agentLoopContent, userMessageId, next.onEvent,
    Object.keys(drainLoopOptions).length > 0 ? drainLoopOptions : undefined,
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
  await session.ensureActorScopedHistory();
  session.currentActiveSurfaceId = activeSurfaceId;
  session.currentPage = currentPage;
  const trimmedContent = content.trim();
  const canonicalPendingRequestsForConversation = trimmedContent.length > 0
    ? listPendingCanonicalGuardianRequestsByDestinationConversation(session.conversationId, 'vellum')
    : [];
  const canonicalPendingRequestIdsForConversation = canonicalPendingRequestsForConversation.map((request) => request.id);

  // ── Canonical guardian reply router (desktop/session path) ──
  // Attempts to route inbound messages through the canonical decision pipeline
  // before falling through to the legacy guardian action interception. Handles
  // deterministic request code prefixes and NL classification, with all
  // decisions flowing through applyCanonicalGuardianDecision.
  if (trimmedContent.length > 0) {
    const routerResult = await routeGuardianReply({
      messageText: trimmedContent,
      channel: 'vellum',
      actor: {
        externalUserId: undefined,
        channel: 'vellum',
        isTrusted: true,
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
        userMessageChannel: 'vellum' as const,
        assistantMessageChannel: 'vellum' as const,
        userMessageInterface: guardianIfCtx?.userMessageInterface ?? 'vellum',
        assistantMessageInterface: guardianIfCtx?.assistantMessageInterface ?? 'vellum',
        provenanceActorRole: 'guardian' as const,
      };

      const userMsg = createUserMessage(content, attachments);
      const persisted = await conversationStore.addMessage(
        session.conversationId,
        'user',
        JSON.stringify(userMsg.content),
        routerChannelMeta,
      );
      session.messages.push(userMsg);

      const replyText = routerResult.replyText
        ?? (routerResult.decisionApplied ? 'Decision applied.' : 'Request already resolved.');
      const assistantMsg = createAssistantMessage(replyText);
      await conversationStore.addMessage(
        session.conversationId,
        'assistant',
        JSON.stringify(assistantMsg.content),
        routerChannelMeta,
      );
      session.messages.push(assistantMsg);

      onEvent({ type: 'assistant_text_delta', text: replyText });
      onEvent({ type: 'message_complete', sessionId: session.conversationId });

      log.info(
        { conversationId: session.conversationId, routerType: routerResult.type, requestId: routerResult.requestId },
        'Session guardian reply routed through canonical pipeline',
      );

      return persisted.id;
    }
  }

  // ── Unified guardian action answer interception (mac channel) ──
  // Skip legacy interception whenever canonical pending requests are already
  // bound to this conversation. This prevents stale legacy rows from
  // disambiguating replies intended for the canonical request.
  // Deterministic priority matching: pending → follow-up → expired.
  // When the guardian includes an explicit request code, match it across all
  // states in priority order. When only one actionable request exists,
  // auto-match without requiring a code prefix.
  if (canonicalPendingRequestIdsForConversation.length === 0) {
    const allPending = getPendingDeliveriesByConversation(session.conversationId);
    const allFollowup = getFollowupDeliveriesByConversation(session.conversationId);
    const allExpired = getExpiredDeliveriesByConversation(session.conversationId);
    const totalActionable = allPending.length + allFollowup.length + allExpired.length;

    if (totalActionable > 0) {
      const guardianIfCtx = session.getTurnInterfaceContext();
      const guardianChannelMeta = { userMessageChannel: 'vellum' as const, assistantMessageChannel: 'vellum' as const, userMessageInterface: guardianIfCtx?.userMessageInterface ?? 'vellum', assistantMessageInterface: guardianIfCtx?.assistantMessageInterface ?? 'vellum', provenanceActorRole: 'guardian' as const };

      // Try to parse an explicit request code from the message, in priority order
      type CodeMatch = { delivery: typeof allPending[0]; request: NonNullable<ReturnType<typeof getGuardianActionRequest>>; state: 'pending' | 'followup' | 'expired'; answerText: string };
      let codeMatch: CodeMatch | null = null;
      const upperContent = content.toUpperCase();
      const orderedSets: Array<{ deliveries: typeof allPending; state: 'pending' | 'followup' | 'expired' }> = [
        { deliveries: allPending, state: 'pending' },
        { deliveries: allFollowup, state: 'followup' },
        { deliveries: allExpired, state: 'expired' },
      ];
      for (const { deliveries, state } of orderedSets) {
        for (const d of deliveries) {
          const req = getGuardianActionRequest(d.requestId);
          if (req && upperContent.startsWith(req.requestCode)) {
            codeMatch = { delivery: d, request: req, state, answerText: content.slice(req.requestCode.length).trim() };
            break;
          }
        }
        if (codeMatch) break;
      }

      // Explicit code targets a non-pending state: handle terminal superseded
      if (codeMatch && codeMatch.state !== 'pending') {
        const targetReq = codeMatch.request;
        if (targetReq.status === 'expired' && targetReq.expiredReason === 'superseded') {
          const callSession = getCallSession(targetReq.callSessionId);
          const callStillActive = callSession && !isTerminalState(callSession.status);
          if (!callStillActive) {
            const userMsg = createUserMessage(content, attachments);
            const persisted = await conversationStore.addMessage(session.conversationId, 'user', JSON.stringify(userMsg.content), guardianChannelMeta);
            session.messages.push(userMsg);
            const staleText = await composeGuardianActionMessageGenerative({ scenario: 'guardian_stale_superseded' }, {}, _guardianActionCopyGenerator);
            const staleMsg = createAssistantMessage(staleText);
            await conversationStore.addMessage(session.conversationId, 'assistant', JSON.stringify(staleMsg.content), guardianChannelMeta);
            session.messages.push(staleMsg);
            onEvent({ type: 'assistant_text_delta', text: staleText });
            onEvent({ type: 'message_complete', sessionId: session.conversationId });
            return persisted.id;
          }
        }
      }

      // Auto-match: single actionable request across all states
      if (!codeMatch && totalActionable === 1) {
        const singleDelivery = allPending[0] ?? allFollowup[0] ?? allExpired[0];
        const singleReq = getGuardianActionRequest(singleDelivery.requestId);
        if (singleReq) {
          const state: 'pending' | 'followup' | 'expired' = allPending.length === 1 ? 'pending' : allFollowup.length === 1 ? 'followup' : 'expired';
          let text = content;
          if (upperContent.startsWith(singleReq.requestCode)) {
            text = content.slice(singleReq.requestCode.length).trim();
          }
          codeMatch = { delivery: singleDelivery, request: singleReq, state, answerText: text };
        }
      }

      // Unknown code: message starts with a 6-char alphanumeric token that doesn't match
      if (!codeMatch && totalActionable > 0) {
        const possibleCodeMatch = content.match(/^([A-F0-9]{6})\s/i);
        if (possibleCodeMatch) {
          const candidateCode = possibleCodeMatch[1].toUpperCase();
          const allDeliveries = [...allPending, ...allFollowup, ...allExpired];
          const knownCodes = allDeliveries
            .map((d) => { const req = getGuardianActionRequest(d.requestId); return req?.requestCode; })
            .filter((code): code is string => typeof code === 'string');
          if (!knownCodes.includes(candidateCode)) {
            const userMsg = createUserMessage(content, attachments);
            const persisted = await conversationStore.addMessage(session.conversationId, 'user', JSON.stringify(userMsg.content), guardianChannelMeta);
            session.messages.push(userMsg);
            const unknownText = await composeGuardianActionMessageGenerative({ scenario: 'guardian_unknown_code', unknownCode: candidateCode }, {}, _guardianActionCopyGenerator);
            const unknownMsg = createAssistantMessage(unknownText);
            await conversationStore.addMessage(session.conversationId, 'assistant', JSON.stringify(unknownMsg.content), guardianChannelMeta);
            session.messages.push(unknownMsg);
            onEvent({ type: 'assistant_text_delta', text: unknownText });
            onEvent({ type: 'message_complete', sessionId: session.conversationId });
            return persisted.id;
          }
        }
      }

      // No match and multiple actionable requests → disambiguation
      if (!codeMatch && totalActionable > 1) {
        const userMsg = createUserMessage(content, attachments);
        const persisted = await conversationStore.addMessage(session.conversationId, 'user', JSON.stringify(userMsg.content), guardianChannelMeta);
        session.messages.push(userMsg);
        const allDeliveries = [...allPending, ...allFollowup, ...allExpired];
        const codes = allDeliveries
          .map((d) => { const req = getGuardianActionRequest(d.requestId); return req ? req.requestCode : null; })
          .filter((code): code is string => typeof code === 'string' && code.length > 0);
        const disambiguationScenario = allPending.length > 0
          ? 'guardian_pending_disambiguation' as const
          : allFollowup.length > 0
            ? 'guardian_followup_disambiguation' as const
            : 'guardian_expired_disambiguation' as const;
        const disambiguationText = await composeGuardianActionMessageGenerative(
          { scenario: disambiguationScenario, requestCodes: codes },
          { requiredKeywords: codes },
          _guardianActionCopyGenerator,
        );
        const disambiguationMsg = createAssistantMessage(disambiguationText);
        await conversationStore.addMessage(session.conversationId, 'assistant', JSON.stringify(disambiguationMsg.content), guardianChannelMeta);
        session.messages.push(disambiguationMsg);
        onEvent({ type: 'assistant_text_delta', text: disambiguationText });
        onEvent({ type: 'message_complete', sessionId: session.conversationId });
        return persisted.id;
      }

      // Dispatch matched delivery by state
      if (codeMatch) {
        const { request, state, answerText } = codeMatch;

        // PENDING state handler
        if (state === 'pending' && request.status === 'pending') {
          const userMsg = createUserMessage(content, attachments);
          const persisted = await conversationStore.addMessage(session.conversationId, 'user', JSON.stringify(userMsg.content), guardianChannelMeta);
          session.messages.push(userMsg);

          const answerResult = await answerCall({ callSessionId: request.callSessionId, answer: answerText, pendingQuestionId: request.pendingQuestionId });

          if ('ok' in answerResult && answerResult.ok) {
            const resolved = resolveGuardianActionRequest(request.id, answerText, 'vellum');
            if (resolved) {
              await tryMintGuardianActionGrant({ request, answerText, decisionChannel: 'vellum', approvalConversationGenerator: _approvalConversationGenerator });
            }
            const replyText = resolved
              ? 'Your answer has been relayed to the call.'
              : await composeGuardianActionMessageGenerative({ scenario: 'guardian_stale_answered' }, {}, _guardianActionCopyGenerator);
            const replyMsg = createAssistantMessage(replyText);
            await conversationStore.addMessage(session.conversationId, 'assistant', JSON.stringify(replyMsg.content), guardianChannelMeta);
            session.messages.push(replyMsg);
            onEvent({ type: 'assistant_text_delta', text: replyText });
          } else {
            const errorDetail = 'error' in answerResult ? answerResult.error : 'Unknown error';
            log.warn({ callSessionId: request.callSessionId, error: errorDetail }, 'answerCall failed for mac guardian answer');
            const failureText = await composeGuardianActionMessageGenerative({ scenario: 'guardian_answer_delivery_failed' }, {}, _guardianActionCopyGenerator);
            const failMsg = createAssistantMessage(failureText);
            await conversationStore.addMessage(session.conversationId, 'assistant', JSON.stringify(failMsg.content), guardianChannelMeta);
            session.messages.push(failMsg);
            onEvent({ type: 'assistant_text_delta', text: failureText });
          }
          onEvent({ type: 'message_complete', sessionId: session.conversationId });
          return persisted.id;
        }

        // FOLLOW-UP state handler
        if (state === 'followup' && request.followupState === 'awaiting_guardian_choice') {
          const userMsg = createUserMessage(content, attachments);
          const persisted = await conversationStore.addMessage(session.conversationId, 'user', JSON.stringify(userMsg.content), guardianChannelMeta);
          session.messages.push(userMsg);

          const turnResult = await processGuardianFollowUpTurn(
            { questionText: request.questionText, lateAnswerText: request.lateAnswerText ?? '', guardianReply: answerText },
            _guardianFollowUpGenerator,
          );

          let stateApplied = true;
          if (turnResult.disposition === 'call_back' || turnResult.disposition === 'message_back') {
            stateApplied = Boolean(progressFollowupState(request.id, 'dispatching', turnResult.disposition));
          } else if (turnResult.disposition === 'decline') {
            stateApplied = Boolean(finalizeFollowup(request.id, 'declined'));
          }

          if (!stateApplied) {
            log.warn({ requestId: request.id, disposition: turnResult.disposition }, 'Follow-up state transition failed (already resolved)');
          }

          const replyText = stateApplied
            ? turnResult.replyText
            : await composeGuardianActionMessageGenerative({ scenario: 'guardian_stale_followup' }, {}, _guardianActionCopyGenerator);
          const replyMsg = createAssistantMessage(replyText);
          await conversationStore.addMessage(session.conversationId, 'assistant', JSON.stringify(replyMsg.content), guardianChannelMeta);
          session.messages.push(replyMsg);
          onEvent({ type: 'assistant_text_delta', text: replyText });
          onEvent({ type: 'message_complete', sessionId: session.conversationId });

          if (stateApplied && (turnResult.disposition === 'call_back' || turnResult.disposition === 'message_back')) {
            void (async () => {
              try {
                const execResult = await executeFollowupAction(request.id, turnResult.disposition as 'call_back' | 'message_back', _guardianActionCopyGenerator);
                const completionMsg = createAssistantMessage(execResult.guardianReplyText);
                await conversationStore.addMessage(session.conversationId, 'assistant', JSON.stringify(completionMsg.content), guardianChannelMeta);
                session.messages.push(completionMsg);
                onEvent({ type: 'assistant_text_delta', text: execResult.guardianReplyText });
                onEvent({ type: 'message_complete', sessionId: session.conversationId });
              } catch (execErr) {
                log.error({ err: execErr, requestId: request.id }, 'Follow-up action execution or completion message failed');
              }
            })();
          }
          return persisted.id;
        }

        // EXPIRED state handler
        if (state === 'expired' && request.status === 'expired' && request.followupState === 'none') {
          const userMsg = createUserMessage(content, attachments);
          const persisted = await conversationStore.addMessage(session.conversationId, 'user', JSON.stringify(userMsg.content), guardianChannelMeta);
          session.messages.push(userMsg);

          // Superseded remap
          if (request.expiredReason === 'superseded') {
            const callSession = getCallSession(request.callSessionId);
            const callStillActive = callSession && !isTerminalState(callSession.status);
            const currentPending = callStillActive ? getPendingRequestByCallSessionId(request.callSessionId) : null;

            if (callStillActive && currentPending) {
              const currentDeliveries = getDeliveriesByRequestId(currentPending.id);
              const guardianExtUserId = session.guardianContext?.guardianExternalUserId;
              // When guardianExternalUserId is present, verify the sender has a
              // matching delivery on the current pending request. When it's absent
              // (trusted Vellum/HTTP session), allow the remap without delivery check.
              const senderHasDelivery = guardianExtUserId
                ? currentDeliveries.some((d) => d.destinationExternalUserId === guardianExtUserId)
                : true;
              if (!senderHasDelivery) {
                log.info({ supersededRequestId: request.id, currentRequestId: currentPending.id, guardianExternalUserId: guardianExtUserId }, 'Superseded remap skipped: sender has no delivery on current pending request');
              } else {
                const remapResult = await answerCall({ callSessionId: currentPending.callSessionId, answer: answerText, pendingQuestionId: currentPending.pendingQuestionId });
                if ('ok' in remapResult && remapResult.ok) {
                  const resolved = resolveGuardianActionRequest(currentPending.id, answerText, 'vellum');
                  if (resolved) {
                    await tryMintGuardianActionGrant({ request: currentPending, answerText, decisionChannel: 'vellum', approvalConversationGenerator: _approvalConversationGenerator });
                  }
                  const remapText = await composeGuardianActionMessageGenerative({ scenario: 'guardian_superseded_remap', questionText: currentPending.questionText }, {}, _guardianActionCopyGenerator);
                  const remapMsg = createAssistantMessage(remapText);
                  await conversationStore.addMessage(session.conversationId, 'assistant', JSON.stringify(remapMsg.content), guardianChannelMeta);
                  session.messages.push(remapMsg);
                  onEvent({ type: 'assistant_text_delta', text: remapText });
                  onEvent({ type: 'message_complete', sessionId: session.conversationId });
                  log.info({ supersededRequestId: request.id, remappedToRequestId: currentPending.id }, 'Late approval for superseded request remapped to current pending request');
                  return persisted.id;
                }
                log.warn({ callSessionId: currentPending.callSessionId, error: 'error' in remapResult ? remapResult.error : 'unknown' }, 'Superseded remap answerCall failed, falling through to follow-up');
              }
            }
          }

          const followupResult = startFollowupFromExpiredRequest(request.id, answerText);
          if (followupResult) {
            const followupText = await composeGuardianActionMessageGenerative({ scenario: 'guardian_late_answer_followup', questionText: request.questionText, lateAnswerText: answerText }, {}, _guardianActionCopyGenerator);
            const replyMsg = createAssistantMessage(followupText);
            await conversationStore.addMessage(session.conversationId, 'assistant', JSON.stringify(replyMsg.content), guardianChannelMeta);
            session.messages.push(replyMsg);
            onEvent({ type: 'assistant_text_delta', text: followupText });
          } else {
            const staleText = await composeGuardianActionMessageGenerative({ scenario: 'guardian_stale_expired' }, {}, _guardianActionCopyGenerator);
            const staleMsg = createAssistantMessage(staleText);
            await conversationStore.addMessage(session.conversationId, 'assistant', JSON.stringify(staleMsg.content), guardianChannelMeta);
            session.messages.push(staleMsg);
            onEvent({ type: 'assistant_text_delta', text: staleText });
          }
          onEvent({ type: 'message_complete', sessionId: session.conversationId });
          return persisted.id;
        }
      }
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
    const persisted = await conversationStore.addMessage(
      session.conversationId,
      'user',
      contentToPersist,
      pmChannelMeta,
    );
    session.messages.push(userMsg);

    const assistantMsg = createAssistantMessage(slashResult.message);
    await conversationStore.addMessage(
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

  const resolvedContent = slashResult.content;

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
    } else {
      // Guardian invite intent interception — force invite management
      // requests into the trusted-contacts skill flow.
      const inviteIntent = resolveGuardianInviteIntent(resolvedContent);
      if (inviteIntent.kind === 'invite_management') {
        log.info({ conversationId: session.conversationId, action: inviteIntent.action }, 'Guardian invite intent intercepted — forcing skill flow');
        agentLoopContent = inviteIntent.rewrittenContent;
        session.preactivatedSkillIds = ['trusted-contacts'];
      }
    }
  }

  let userMessageId: string;
  try {
    userMessageId = await session.persistUserMessage(resolvedContent, attachments, requestId, undefined, displayContent);
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

  const loopOptions: { isInteractive?: boolean; titleText?: string } = {};
  if (options?.isInteractive !== undefined) loopOptions.isInteractive = options.isInteractive;
  if (agentLoopContent !== resolvedContent) loopOptions.titleText = resolvedContent;

  await session.runAgentLoop(agentLoopContent, userMessageId, onEvent,
    Object.keys(loopOptions).length > 0 ? loopOptions : undefined,
  );
  return userMessageId;
}
