/**
 * Call-answer bridge: auto-consumes user replies in-thread as answers
 * to pending call questions, routing them to the live call orchestrator.
 *
 * When a call has a pending question and the user sends a normal message
 * in the conversation thread, this bridge intercepts the message before
 * the agent loop, forwards the answer to the orchestrator, and returns
 * `{ handled: true }` so the caller can skip agent processing.
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
import * as conversationStore from '../memory/conversation-store.js';

const log = getLogger('call-bridge');

export interface CallBridgeResult {
  handled: boolean;
  reason?: string;
}

/**
 * Attempt to route a user message as an answer to a pending call question.
 *
 * @param conversationId - The conversation the message belongs to.
 * @param userText - The user's message text.
 * @param _userMessageId - The persisted message ID (reserved for future use).
 * @returns `{ handled: true }` if the answer was consumed by the call system,
 *          `{ handled: false, reason }` otherwise.
 */
export async function tryHandlePendingCallAnswer(
  conversationId: string,
  userText: string,
  _userMessageId?: string,
): Promise<CallBridgeResult> {
  // 1. Find an active call for this conversation
  const callSession = getActiveCallSessionForConversation(conversationId);
  if (!callSession) {
    return { handled: false, reason: 'no_active_call' };
  }

  // 2. Check for a pending question
  const pendingQuestion = getPendingQuestion(callSession.id);
  if (!pendingQuestion) {
    return { handled: false, reason: 'no_pending_question' };
  }

  // 3. Check that the orchestrator is alive and waiting
  const orchestrator = getCallOrchestrator(callSession.id);
  if (!orchestrator) {
    // The call may have ended between the question being asked and the
    // user replying. Persist a follow-up message so the user knows.
    const freshSession = getCallSession(callSession.id);
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

  // 4. Route the answer through the orchestrator
  const accepted = await orchestrator.handleUserAnswer(userText);
  if (!accepted) {
    return { handled: false, reason: 'orchestrator_rejected' };
  }

  // 5. Persist the answered state
  answerPendingQuestion(pendingQuestion.id, userText);
  recordCallEvent(callSession.id, 'user_answered', { answer: userText });

  log.info(
    { conversationId, callSessionId: callSession.id, questionId: pendingQuestion.id },
    'User reply routed as call answer via bridge',
  );

  return { handled: true };
}
