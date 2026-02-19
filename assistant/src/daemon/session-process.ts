/**
 * Queue drain and message processing logic extracted from Session.
 *
 * Session delegates `drainQueue` and `processMessage` to the module-level
 * functions exported here, following the same context-interface pattern
 * used by session-history.ts.
 */

import type { Message } from '../providers/types.js';
import type { ServerMessage, UserMessageAttachment } from './ipc-protocol.js';
import type { MessageQueue } from './session-queue-manager.js';
import type { QueueDrainReason } from './session-queue-manager.js';
import type { TraceEmitter } from './trace-emitter.js';
import { createUserMessage, createAssistantMessage } from '../agent/message-types.js';
import * as conversationStore from '../memory/conversation-store.js';
import { resolveSlash } from './session-slash.js';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('session-process');

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
  readonly queue: MessageQueue;
  readonly traceEmitter: TraceEmitter;
  currentActiveSurfaceId?: string;
  currentPage?: string;
  /** Request-scoped skill IDs preactivated via slash resolution. */
  preactivatedSkillIds?: string[];
  /** Working directory of the session, used for CC command discovery. */
  readonly workingDir?: string;
  persistUserMessage(content: string, attachments: UserMessageAttachment[], requestId?: string): string;
  runAgentLoop(
    content: string,
    userMessageId: string,
    onEvent: (msg: ServerMessage) => void,
    options?: { skipPreMessageRollback?: boolean },
  ): Promise<void>;
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

  // Resolve slash commands for queued messages
  const slashResult = resolveSlash(next.content, session.workingDir);

  // Unknown slash — persist the exchange and continue draining.
  // Persist each message before pushing to session.messages so that a
  // failed write never leaves an unpersisted message in memory.
  if (slashResult.kind === 'unknown') {
    try {
      const userMsg = createUserMessage(next.content, next.attachments);
      conversationStore.addMessage(
        session.conversationId,
        'user',
        JSON.stringify(userMsg.content),
      );
      session.messages.push(userMsg);

      const assistantMsg = createAssistantMessage(slashResult.message);
      conversationStore.addMessage(
        session.conversationId,
        'assistant',
        JSON.stringify(assistantMsg.content),
      );
      session.messages.push(assistantMsg);

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

  const resolvedContent = slashResult.content;

  // Preactivate skill tools when slash resolution identifies a known skill
  if (slashResult.kind === 'rewritten') {
    session.preactivatedSkillIds = [slashResult.skillId];
  } else if (slashResult.kind === 'cc_command') {
    session.preactivatedSkillIds = ['claude-code'];
  }

  // Try to persist and run the dequeued message. If persistUserMessage
  // succeeds, runAgentLoop is called and its finally block will drain
  // the next message. If persistUserMessage fails, processMessage
  // resolves early (no runAgentLoop call), so we must continue draining.
  let userMessageId: string;
  try {
    userMessageId = session.persistUserMessage(resolvedContent, next.attachments, next.requestId);
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

  // Fire-and-forget: persistUserMessage set session.processing = true
  // so subsequent messages will still be enqueued. runAgentLoop's
  // finally block will call drainQueue when this run completes.
  session.runAgentLoop(resolvedContent, userMessageId, next.onEvent).catch((err) => {
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
): Promise<string> {
  session.currentActiveSurfaceId = activeSurfaceId;
  session.currentPage = currentPage;

  // Resolve slash commands before persistence
  const slashResult = resolveSlash(content, session.workingDir);

  // Unknown slash command — persist the exchange (user + assistant) so the
  // messageId is real.  Persist each message before pushing to session.messages
  // so that a failed write never leaves an unpersisted message in memory.
  if (slashResult.kind === 'unknown') {
    const userMsg = createUserMessage(content, attachments);
    const persisted = conversationStore.addMessage(
      session.conversationId,
      'user',
      JSON.stringify(userMsg.content),
    );
    session.messages.push(userMsg);

    const assistantMsg = createAssistantMessage(slashResult.message);
    conversationStore.addMessage(
      session.conversationId,
      'assistant',
      JSON.stringify(assistantMsg.content),
    );
    session.messages.push(assistantMsg);

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
  } else if (slashResult.kind === 'cc_command') {
    session.preactivatedSkillIds = ['claude-code'];
  }

  let userMessageId: string;
  try {
    userMessageId = session.persistUserMessage(resolvedContent, attachments, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent({ type: 'error', message });
    // runAgentLoop never ran, so its finally block won't clear this
    session.preactivatedSkillIds = undefined;
    return '';
  }

  await session.runAgentLoop(resolvedContent, userMessageId, onEvent);
  return userMessageId;
}
