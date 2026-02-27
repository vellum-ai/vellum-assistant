// Guardian action decision IPC types.
// Enables desktop clients to fetch pending guardian prompts and submit
// button decisions deterministically (without text parsing).

// === Client -> Server ===

export interface GuardianActionsPendingRequest {
  type: 'guardian_actions_pending_request';
  conversationId: string;
}

export interface GuardianActionDecision {
  type: 'guardian_action_decision';
  requestId: string;
  action: string;
  conversationId?: string;
}

// === Server -> Client ===

export interface GuardianActionsPendingResponse {
  type: 'guardian_actions_pending_response';
  prompts: Array<{
    requestId: string;
    requestCode: string;
    state: string;
    questionText: string;
    toolName: string | null;
    actions: Array<{ action: string; label: string }>;
    expiresAt: number;
    conversationId: string;
    callSessionId: string | null;
  }>;
}

export interface GuardianActionDecisionResponse {
  type: 'guardian_action_decision_response';
  applied: boolean;
  reason?: string;
  requestId?: string;
  userText?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _GuardianActionsClientMessages =
  | GuardianActionsPendingRequest
  | GuardianActionDecision;

export type _GuardianActionsServerMessages =
  | GuardianActionsPendingResponse
  | GuardianActionDecisionResponse;
