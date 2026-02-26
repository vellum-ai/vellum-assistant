export type CallStatus = 'initiated' | 'ringing' | 'in_progress' | 'waiting_on_user' | 'completed' | 'failed' | 'cancelled';
export type CallEventType = 'call_started' | 'call_connected' | 'caller_spoke' | 'assistant_spoke' | 'user_question_asked' | 'user_answered' | 'user_instruction_relayed' | 'call_ended' | 'call_failed' | 'callee_verification_started' | 'callee_verification_succeeded' | 'callee_verification_failed' | 'guardian_voice_verification_started' | 'guardian_voice_verification_succeeded' | 'guardian_voice_verification_failed' | 'outbound_guardian_voice_verification_started' | 'outbound_guardian_voice_verification_succeeded' | 'outbound_guardian_voice_verification_failed';
export type PendingQuestionStatus = 'pending' | 'answered' | 'expired' | 'cancelled';

/**
 * Explicit call mode written at session creation time. The relay server
 * uses this as the primary signal for deterministic flow selection,
 * with Twilio setup custom parameters as a secondary/observability signal.
 */
export type CallMode = 'normal' | 'guardian_verification';

export interface CallSession {
  id: string;
  conversationId: string;
  provider: string;
  providerCallSid: string | null;
  fromNumber: string;
  toNumber: string;
  task: string | null;
  status: CallStatus;
  callMode: CallMode | null;
  guardianVerificationSessionId: string | null;
  callerIdentityMode: string | null;
  callerIdentitySource: string | null;
  assistantId: string | null;
  initiatedFromConversationId?: string | null;
  startedAt: number | null;
  endedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CallEvent {
  id: string;
  callSessionId: string;
  eventType: CallEventType;
  payloadJson: string;
  createdAt: number;
}

export interface CallPendingQuestion {
  id: string;
  callSessionId: string;
  questionText: string;
  status: PendingQuestionStatus;
  askedAt: number;
  answeredAt: number | null;
  answerText: string | null;
}
