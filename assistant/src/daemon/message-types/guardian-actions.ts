// Guardian action decision message types.
// Enables desktop clients to fetch pending guardian prompts and submit
// button decisions deterministically (without text parsing).

import type { GuardianDecisionPrompt } from "../../runtime/guardian-decision-types.js";

// === Client -> Server ===

export interface GuardianActionsPendingRequest {
  type: "guardian_actions_pending_request";
  conversationId: string;
}

export interface GuardianActionDecision {
  type: "guardian_action_decision";
  requestId: string;
  action: string;
  conversationId?: string;
}

// === Server -> Client ===

export interface GuardianActionsPendingResponse {
  type: "guardian_actions_pending_response";
  conversationId: string;
  prompts: GuardianDecisionPrompt[];
}

export interface GuardianActionDecisionResponse {
  type: "guardian_action_decision_response";
  applied: boolean;
  reason?: string;
  resolverFailureReason?: string;
  requestId?: string;
  userText?: string;
  /** Resolver reply text for the guardian (e.g. verification code for access requests). */
  replyText?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _GuardianActionsClientMessages =
  | GuardianActionsPendingRequest
  | GuardianActionDecision;

export type _GuardianActionsServerMessages =
  | GuardianActionsPendingResponse
  | GuardianActionDecisionResponse;
