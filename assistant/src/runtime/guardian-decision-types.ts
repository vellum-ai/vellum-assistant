/**
 * Shared types for the guardian decision primitive.
 *
 * All decision entrypoints (callback buttons, conversational engine, legacy
 * parser, requester self-cancel) use these types to route through the
 * unified `applyGuardianDecision` primitive.
 */

import type { ChannelId } from '../channels/types.js';

// ---------------------------------------------------------------------------
// Guardian decision prompt
// ---------------------------------------------------------------------------

/** Structured model for prompts shown to guardians. */
export interface GuardianDecisionPrompt {
  requestId: string;
  /** Short human-readable code for the request. */
  requestCode: string;
  state: 'pending' | 'followup_awaiting_choice' | 'expired_superseded_with_active_call';
  questionText: string;
  toolName: string | null;
  actions: GuardianDecisionAction[];
  expiresAt: number;
  conversationId: string;
  callSessionId: string | null;
}

export interface GuardianDecisionAction {
  /** Canonical action identifier. */
  action: string;
  /** Human-readable label for the action. */
  label: string;
}

// ---------------------------------------------------------------------------
// Apply decision
// ---------------------------------------------------------------------------

export interface ApplyGuardianDecisionParams {
  requestId: string;
  action: string;
  actorExternalUserId: string | undefined;
  actorChannel: ChannelId;
  conversationId?: string;
  callSessionId?: string;
}

export interface ApplyGuardianDecisionResult {
  applied: boolean;
  reason?: 'stale' | 'identity_mismatch' | 'invalid_action' | 'not_found' | 'expired';
  requestId?: string;
  /** Feedback text when the action was parsed from user text. */
  userText?: string;
}
