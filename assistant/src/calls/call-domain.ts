/**
 * Shared domain functions for call operations.
 *
 * Both the tool implementations and the HTTP route handlers delegate
 * to these functions so business logic lives in one place.
 */

import { getLogger } from '../util/logger.js';
import { DENIED_NUMBERS } from './call-constants.js';
import {
  createCallSession,
  getCallSession,
  getActiveCallSessionForConversation,
  updateCallSession,
  getPendingQuestion,
  answerPendingQuestion,
} from './call-store.js';
import { getCallOrchestrator, unregisterCallOrchestrator } from './call-state.js';
import { activeRelayConnections } from './relay-server.js';
import { TwilioConversationRelayProvider } from './twilio-provider.js';
import { getTwilioConfig } from './twilio-config.js';
import type { CallSession } from './types.js';

const log = getLogger('call-domain');

const E164_REGEX = /^\+\d+$/;

// ── Result types ─────────────────────────────────────────────────────

export interface StartCallResult {
  ok: true;
  session: CallSession;
  callSid: string;
}

export interface CallError {
  ok: false;
  error: string;
  status?: number;
}

export type StartCallInput = {
  phoneNumber: string;
  task: string;
  context?: string;
  conversationId: string;
};

export type CancelCallInput = {
  callSessionId: string;
  reason?: string;
};

export type AnswerCallInput = {
  callSessionId: string;
  answer: string;
};

// ── Domain operations ────────────────────────────────────────────────

/**
 * Initiate a new outbound call.
 */
export async function startCall(input: StartCallInput): Promise<StartCallResult | CallError> {
  const { phoneNumber, task, context: callContext, conversationId } = input;

  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return { ok: false, error: 'phone_number is required and must be a string', status: 400 };
  }

  if (!E164_REGEX.test(phoneNumber)) {
    return {
      ok: false,
      error: 'phone_number must be in E.164 format (starts with + followed by digits, e.g. +14155551234)',
      status: 400,
    };
  }

  if (!task || typeof task !== 'string' || task.trim().length === 0) {
    return { ok: false, error: 'task is required and must be a non-empty string', status: 400 };
  }

  if (DENIED_NUMBERS.has(phoneNumber)) {
    return { ok: false, error: 'This phone number is not allowed to be called', status: 403 };
  }

  let sessionId: string | null = null;

  try {
    const config = getTwilioConfig();
    const provider = new TwilioConversationRelayProvider();

    const session = createCallSession({
      conversationId,
      provider: 'twilio',
      fromNumber: config.phoneNumber,
      toNumber: phoneNumber,
      task: callContext ? `${task}\n\nContext: ${callContext}` : task,
    });
    sessionId = session.id;

    log.info({ callSessionId: session.id, to: phoneNumber, task }, 'Initiating outbound call');

    const baseUrl = config.webhookBaseUrl.replace(/\/$/, '');
    const { callSid } = await provider.initiateCall({
      from: config.phoneNumber,
      to: phoneNumber,
      webhookUrl: `${baseUrl}/v1/calls/twilio/voice-webhook?callSessionId=${session.id}`,
      statusCallbackUrl: `${baseUrl}/v1/calls/twilio/status`,
    });

    updateCallSession(session.id, { providerCallSid: callSid });

    log.info({ callSessionId: session.id, callSid }, 'Call initiated successfully');

    return {
      ok: true,
      session: { ...session, providerCallSid: callSid },
      callSid,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, phoneNumber }, 'Failed to initiate call');

    if (sessionId) {
      updateCallSession(sessionId, {
        status: 'failed',
        endedAt: Date.now(),
        lastError: msg,
      });
    }

    return { ok: false, error: `Error initiating call: ${msg}`, status: 500 };
  }
}

/**
 * Get the status of a call session. If no callSessionId is provided,
 * looks up the active call for the given conversationId.
 */
export function getCallStatus(
  callSessionId?: string,
  conversationId?: string,
): { ok: true; session: CallSession; pendingQuestion?: { id: string; questionText: string } } | CallError {
  let session: CallSession | null = null;

  if (callSessionId) {
    session = getCallSession(callSessionId);
    if (!session) {
      return { ok: false, error: `No call session found with ID ${callSessionId}`, status: 404 };
    }
  } else if (conversationId) {
    session = getActiveCallSessionForConversation(conversationId);
    if (!session) {
      return { ok: false, error: 'No active call found in the current conversation', status: 404 };
    }
  } else {
    return { ok: false, error: 'Either callSessionId or conversationId is required', status: 400 };
  }

  log.info({ callSessionId: session.id, status: session.status }, 'Checking call status');

  const pendingQuestion = getPendingQuestion(session.id);
  return {
    ok: true,
    session,
    pendingQuestion: pendingQuestion
      ? { id: pendingQuestion.id, questionText: pendingQuestion.questionText }
      : undefined,
  };
}

/**
 * Cancel an active call. Cleans up relay connections and orchestrators.
 */
export async function cancelCall(input: CancelCallInput): Promise<{ ok: true; session: CallSession } | CallError> {
  const { callSessionId, reason } = input;

  const session = getCallSession(callSessionId);
  if (!session) {
    return { ok: false, error: `No call session found with ID ${callSessionId}`, status: 404 };
  }

  if (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled') {
    return { ok: false, error: `Call session ${callSessionId} has already ended with status: ${session.status}`, status: 409 };
  }

  log.info({ callSessionId, reason }, 'Cancelling call');

  // Terminate the call via the provider API
  if (session.providerCallSid) {
    try {
      const provider = new TwilioConversationRelayProvider();
      await provider.endCall(session.providerCallSid);
    } catch (endErr) {
      log.warn({ err: endErr, callSessionId, callSid: session.providerCallSid }, 'Failed to terminate call via provider API — proceeding with cleanup');
    }
  }

  // End the relay connection if active
  const relayConnection = activeRelayConnections.get(callSessionId);
  if (relayConnection) {
    relayConnection.endSession(reason);
    relayConnection.destroy();
    activeRelayConnections.delete(callSessionId);
  }

  // Clean up orchestrator
  const orchestrator = getCallOrchestrator(callSessionId);
  if (orchestrator) {
    orchestrator.destroy();
    unregisterCallOrchestrator(callSessionId);
  }

  // Update session status
  updateCallSession(callSessionId, {
    status: 'cancelled',
    endedAt: Date.now(),
  });

  log.info({ callSessionId }, 'Call cancelled successfully');

  const updated = getCallSession(callSessionId);
  return { ok: true, session: updated ?? { ...session, status: 'cancelled', endedAt: Date.now() } };
}

/**
 * Answer a pending question for an active call.
 */
export async function answerCall(input: AnswerCallInput): Promise<{ ok: true; questionId: string } | CallError> {
  const { callSessionId, answer } = input;

  if (!answer || typeof answer !== 'string') {
    return { ok: false, error: 'Missing answer', status: 400 };
  }

  const question = getPendingQuestion(callSessionId);
  if (!question) {
    return { ok: false, error: 'No pending question found', status: 404 };
  }

  const orchestrator = getCallOrchestrator(callSessionId);
  if (!orchestrator) {
    log.warn({ callSessionId }, 'answerCall: no active orchestrator for call session');
    return { ok: false, error: 'No active orchestrator for this call', status: 409 };
  }

  const accepted = await orchestrator.handleUserAnswer(answer);
  if (!accepted) {
    log.warn(
      { callSessionId },
      'answerCall: orchestrator rejected the answer (not in waiting_on_user state)',
    );
    return { ok: false, error: 'Orchestrator is not waiting for an answer', status: 409 };
  }

  answerPendingQuestion(question.id, answer);

  return { ok: true, questionId: question.id };
}
