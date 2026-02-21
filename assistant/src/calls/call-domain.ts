/**
 * Shared domain functions for call operations.
 *
 * Both the tool implementations and the HTTP route handlers delegate
 * to these functions so business logic lives in one place.
 */

import { getLogger } from '../util/logger.js';
import { isDeniedNumber } from './call-constants.js';
import {
  createCallSession,
  getCallSession,
  getActiveCallSessionForConversation,
  updateCallSession,
  getPendingQuestion,
  answerPendingQuestion,
  expirePendingQuestions,
} from './call-store.js';
import { getCallOrchestrator, unregisterCallOrchestrator } from './call-state.js';
import { activeRelayConnections } from './relay-server.js';
import { TwilioConversationRelayProvider } from './twilio-provider.js';
import { getTwilioConfig } from './twilio-config.js';
import { getTwilioVoiceWebhookUrl, getTwilioStatusCallbackUrl } from '../inbound/public-ingress-urls.js';
import { loadConfig } from '../config/loader.js';
import { getSecureKey } from '../security/secure-keys.js';
import type { CallSession } from './types.js';
import type { AssistantConfig } from '../config/types.js';

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
  callerIdentityMode?: 'assistant_number' | 'user_number';
};

export type CancelCallInput = {
  callSessionId: string;
  reason?: string;
};

export type AnswerCallInput = {
  callSessionId: string;
  answer: string;
};

// ── Caller identity resolution ───────────────────────────────────────

export type CallerIdentityResult =
  | { ok: true; mode: 'assistant_number' | 'user_number'; fromNumber: string }
  | { ok: false; error: string };

/**
 * Resolve which phone number to use as the caller ID for an outbound call.
 *
 * - If `requestedMode` is provided and per-call overrides are allowed, use it.
 * - If `requestedMode` is provided but overrides are disabled, return an error.
 * - Otherwise fall through to the configured default mode.
 *
 * For `assistant_number`: uses the Twilio phone number from `getTwilioConfig()`.
 *   No eligibility check is performed — this is a fast path.
 * For `user_number`: uses `config.calls.callerIdentity.userNumber` or the
 *   secure key `credential:twilio:user_phone_number`, then validates that the
 *   number is usable as an outbound caller ID via the Twilio API.
 */
export async function resolveCallerIdentity(
  config: AssistantConfig,
  requestedMode?: 'assistant_number' | 'user_number',
): Promise<CallerIdentityResult> {
  const identityConfig = config.calls.callerIdentity;
  let mode: 'assistant_number' | 'user_number';

  if (requestedMode != null) {
    if (!identityConfig.allowPerCallOverride) {
      return { ok: false, error: 'Per-call caller identity override is disabled in configuration' };
    }
    mode = requestedMode;
  } else {
    mode = identityConfig.defaultMode;
  }

  if (mode === 'assistant_number') {
    const twilioConfig = getTwilioConfig();
    return { ok: true, mode, fromNumber: twilioConfig.phoneNumber };
  }

  // user_number mode: resolve from config or secure key
  const userNumber =
    identityConfig.userNumber ||
    process.env.TWILIO_USER_PHONE_NUMBER ||
    getSecureKey('credential:twilio:user_phone_number') ||
    '';

  if (!userNumber) {
    return {
      ok: false,
      error: 'user_number mode requires a user phone number. Set calls.callerIdentity.userNumber in config or store credential:twilio:user_phone_number via the credential_store tool.',
    };
  }

  // Verify the user number is eligible as a caller ID with Twilio
  const provider = new TwilioConversationRelayProvider();
  const eligibility = await provider.checkCallerIdEligibility(userNumber);
  if (!eligibility.eligible) {
    return { ok: false, error: eligibility.reason! };
  }

  return { ok: true, mode, fromNumber: userNumber };
}

// ── Domain operations ────────────────────────────────────────────────

/**
 * Initiate a new outbound call.
 */
export async function startCall(input: StartCallInput): Promise<StartCallResult | CallError> {
  const { phoneNumber, task, context: callContext, conversationId, callerIdentityMode } = input;

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

  if (isDeniedNumber(phoneNumber)) {
    return { ok: false, error: 'This phone number is not allowed to be called', status: 403 };
  }

  let sessionId: string | null = null;

  try {
    const ingressConfig = loadConfig();
    const provider = new TwilioConversationRelayProvider();

    // Resolve which phone number to use as caller ID
    const identityResult = await resolveCallerIdentity(ingressConfig, callerIdentityMode);
    if (!identityResult.ok) {
      return { ok: false, error: identityResult.error, status: 400 };
    }
    const fromNumber = identityResult.fromNumber;

    const session = createCallSession({
      conversationId,
      provider: 'twilio',
      fromNumber,
      toNumber: phoneNumber,
      task: callContext ? `${task}\n\nContext: ${callContext}` : task,
    });
    sessionId = session.id;

    log.info({ callSessionId: session.id, to: phoneNumber, from: fromNumber, task }, 'Initiating outbound call');

    const { callSid } = await provider.initiateCall({
      from: fromNumber,
      to: phoneNumber,
      webhookUrl: getTwilioVoiceWebhookUrl(ingressConfig, session.id),
      statusCallbackUrl: getTwilioStatusCallbackUrl(ingressConfig),
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

    // FK constraint failure on conversation_id means the conversationId is invalid
    if (err instanceof Error && msg.includes('FOREIGN KEY constraint failed') && !sessionId) {
      return { ok: false, error: `Invalid conversationId: no conversation found with ID ${conversationId}`, status: 400 };
    }

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

  // Expire any pending questions so they don't linger
  expirePendingQuestions(callSessionId);

  // Re-check final status: a concurrent transition (e.g. Twilio callback) may have
  // moved the session to a terminal state before our update, causing it to be skipped.
  const updated = getCallSession(callSessionId);
  if (updated && updated.status !== 'cancelled') {
    log.warn({ callSessionId, finalStatus: updated.status }, 'Cancel lost race — session already transitioned to terminal state');
    return { ok: false, error: `Call session ${callSessionId} transitioned to ${updated.status} before cancellation could be applied`, status: 409 };
  }

  log.info({ callSessionId }, 'Call cancelled successfully');

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
