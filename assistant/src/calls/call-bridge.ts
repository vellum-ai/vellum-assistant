/**
 * Call message bridge: intercepts user messages in-thread and routes them
 * to the live call orchestrator — either as answers to pending questions
 * or as mid-call steering instructions.
 *
 * Decision priority:
 * 1. If a pending question exists → answer path (existing behavior).
 * 2. If no pending question but an active call exists → instruction path.
 *
 * When the bridge consumes a message it returns `{ handled: true }` so
 * the caller can skip agent processing.
 */

import { getLogger } from '../util/logger.js';
import {
  getActiveCallSessionForConversation,
  getPendingQuestion,
  answerPendingQuestion,
  recordCallEvent,
  getCallSession,
} from './call-store.js';
import { getCallOrchestrator } from './call-state.js';
import { relayInstruction } from './call-domain.js';
import * as conversationStore from '../memory/conversation-store.js';

const log = getLogger('call-bridge');

export interface CallBridgeResult {
  handled: boolean;
  reason?: string;
}

/**
 * Attempt to route a user message to an active call — as an answer to
 * a pending question (priority) or as a mid-call steering instruction.
 *
 * @param conversationId - The conversation the message belongs to.
 * @param userText - The user's message text.
 * @param _userMessageId - The persisted message ID (reserved for future use).
 * @returns `{ handled: true }` if the message was consumed by the call system,
 *          `{ handled: false, reason }` otherwise.
 */
export async function tryRouteCallMessage(
  conversationId: string,
  userText: string,
  _userMessageId?: string,
): Promise<CallBridgeResult> {
  // 1. Find an active call for this conversation
  const callSession = getActiveCallSessionForConversation(conversationId);
  if (!callSession) {
    return { handled: false, reason: 'no_active_call' };
  }

  // 2. Check for a pending question — answer path takes priority
  const pendingQuestion = getPendingQuestion(callSession.id);
  if (pendingQuestion) {
    return handleAnswer(conversationId, callSession.id, pendingQuestion, userText);
  }

  // 3. No pending question — instruction path
  return handleInstruction(conversationId, callSession.id, userText);
}

/** @deprecated Use `tryRouteCallMessage` instead. */
export const tryHandlePendingCallAnswer = tryRouteCallMessage;

// ── Answer path ─────────────────────────────────────────────────────

async function handleAnswer(
  conversationId: string,
  callSessionId: string,
  pendingQuestion: { id: string; questionText: string },
  userText: string,
): Promise<CallBridgeResult> {
  const orchestrator = getCallOrchestrator(callSessionId);
  if (!orchestrator) {
    // The call may have ended between the question being asked and the
    // user replying. Persist a follow-up message so the user knows.
    const freshSession = getCallSession(callSessionId);
    const ended = freshSession && (freshSession.status === 'completed' || freshSession.status === 'failed');
    if (ended) {
      conversationStore.addMessage(
        conversationId,
        'assistant',
        JSON.stringify([{
          type: 'text',
          text: 'The call ended before your answer could be relayed to the caller.',
        }]),
      );
    }
    return { handled: false, reason: 'orchestrator_not_found' };
  }

  if (orchestrator.getState() !== 'waiting_on_user') {
    return { handled: false, reason: 'orchestrator_not_waiting' };
  }

  const accepted = await orchestrator.handleUserAnswer(userText);
  if (!accepted) {
    return { handled: false, reason: 'orchestrator_rejected' };
  }

  answerPendingQuestion(pendingQuestion.id, userText);
  recordCallEvent(callSessionId, 'user_answered', { answer: userText });

  log.info(
    { conversationId, callSessionId, questionId: pendingQuestion.id },
    'User reply routed as call answer via bridge',
  );

  return { handled: true };
}

// ── Instruction path ────────────────────────────────────────────────

async function handleInstruction(
  conversationId: string,
  callSessionId: string,
  userText: string,
): Promise<CallBridgeResult> {
  const result = await relayInstruction({ callSessionId, instructionText: userText });

  if (!result.ok) {
    log.warn(
      { conversationId, callSessionId, error: result.error },
      'Instruction relay failed via bridge',
    );
    return { handled: false, reason: 'instruction_relay_failed' };
  }

  // Persist a concise acknowledgement so the user sees confirmation
  conversationStore.addMessage(
    conversationId,
    'assistant',
    JSON.stringify([{ type: 'text', text: 'Instruction relayed to active call.' }]),
  );

  log.info(
    { conversationId, callSessionId },
    'User message routed as call instruction via bridge',
  );

  return { handled: true };
}
