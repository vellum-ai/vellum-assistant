export type CallStatus = 'initiated' | 'ringing' | 'in_progress' | 'waiting_on_user' | 'completed' | 'failed' | 'cancelled';
export type CallEventType = 'call_started' | 'call_connected' | 'caller_spoke' | 'assistant_spoke' | 'user_question_asked' | 'user_answered' | 'call_ended' | 'call_failed';
export type PendingQuestionStatus = 'pending' | 'answered' | 'expired' | 'cancelled';

export interface CallSession {
  id: string;
  conversationId: string;
  provider: string;
  providerCallSid: string | null;
  fromNumber: string;
  toNumber: string;
  task: string | null;
  status: CallStatus;
  callerIdentityMode: string | null;
  callerIdentitySource: string | null;
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
