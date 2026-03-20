export type CallStatus =
  | "initiated"
  | "ringing"
  | "in_progress"
  | "waiting_on_user"
  | "completed"
  | "failed"
  | "cancelled";
export type CallEventType =
  | "call_started"
  | "call_connected"
  | "caller_spoke"
  | "assistant_spoke"
  | "user_question_asked"
  | "user_answered"
  | "user_instruction_relayed"
  | "call_ended"
  | "call_failed"
  | "callee_verification_started"
  | "callee_verification_succeeded"
  | "callee_verification_failed"
  | "voice_verification_started"
  | "voice_verification_succeeded"
  | "voice_verification_failed"
  | "outbound_voice_verification_started"
  | "outbound_voice_verification_succeeded"
  | "outbound_voice_verification_failed"
  | "guardian_consultation_timed_out"
  | "guardian_unavailable_skipped"
  | "guardian_consult_deferred"
  | "guardian_consult_coalesced"
  | "inbound_acl_denied"
  | "inbound_acl_name_capture_started"
  | "inbound_acl_name_captured"
  | "inbound_acl_name_capture_timeout"
  | "inbound_acl_access_approved"
  | "inbound_acl_access_denied"
  | "inbound_acl_access_timeout"
  | "invite_redemption_started"
  | "invite_redemption_succeeded"
  | "invite_redemption_failed"
  | "voice_guardian_wait_heartbeat_sent"
  | "voice_guardian_wait_prompt_classified"
  | "voice_guardian_wait_callback_offer_sent"
  | "voice_guardian_wait_callback_opt_in_set"
  | "voice_guardian_wait_callback_opt_in_declined"
  | "inbound_acl_post_approval_handoff_spoken"
  | "callback_handoff_notified"
  | "callback_handoff_failed";
export type PendingQuestionStatus =
  | "pending"
  | "answered"
  | "expired"
  | "cancelled";

/**
 * Explicit call mode written at session creation time. The relay server
 * uses this as the primary signal for deterministic flow selection,
 * with Twilio setup custom parameters as a secondary/observability signal.
 */
export type CallMode = "normal" | "verification" | "invite";

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
  verificationSessionId: string | null;
  inviteFriendName: string | null;
  inviteGuardianName: string | null;
  callerIdentityMode: string | null;
  callerIdentitySource: string | null;
  skipDisclosure: boolean;
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
