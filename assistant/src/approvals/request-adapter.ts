/**
 * Request adapter for normalizing approval requests from different channels
 * into a unified internal shape.
 *
 * Two producers currently create approval requests:
 *   1. Voice guardian actions (ASK_GUARDIAN markers on calls)
 *   2. Channel guardian approvals (Telegram/SMS tool-approval interception)
 *
 * This adapter normalizes both into a single `NormalizedApprovalRequest` so
 * downstream code (the approval primitive, logging, metrics) can work with
 * one shape regardless of the originating channel.
 */

import type { GuardianActionRequest } from '../memory/guardian-action-store.js';
import type { GuardianApprovalRequest } from '../memory/channel-guardian-store.js';

// ---------------------------------------------------------------------------
// Normalized shape
// ---------------------------------------------------------------------------

export interface NormalizedApprovalRequest {
  /** The assistant this request belongs to. */
  assistantId: string;
  /** Unique identifier for this approval request. */
  requestId: string;
  /** Channel through which the original tool invocation was requested. */
  requestChannel: string;
  /** Channel through which the guardian decision will arrive. */
  decisionChannel: string;
  /** Tool name the approval is for (null for informational consults). */
  toolName: string | null;
  /** Deterministic digest of the tool invocation input (null when no tool metadata). */
  inputDigest: string | null;
  /** Conversation that originated the request. */
  conversationId: string;
  /** Voice call session ID (null for non-voice channels). */
  callSessionId: string | null;
  /** External user ID of the actor who triggered the tool invocation. */
  requesterExternalUserId: string | null;
  /** External user ID of the guardian who will decide. */
  guardianExternalUserId: string | null;
}

// ---------------------------------------------------------------------------
// Voice guardian action adapter
// ---------------------------------------------------------------------------

export interface VoiceGuardianActionContext {
  /** The guardian action request from the voice call path. */
  request: GuardianActionRequest;
  /** Channel the guardian answered on (e.g. 'telegram', 'sms', 'mac'). */
  decisionChannel: string;
  /** External user ID of the guardian who answered. */
  guardianExternalUserId?: string;
}

/**
 * Normalize a voice guardian-action request into the unified shape.
 *
 * Voice guardian actions originate from the call path (ASK_GUARDIAN markers)
 * and carry tool metadata in `toolName` / `inputDigest` fields on the
 * request record.  The `sourceChannel` on the request represents the
 * requester's channel (the voice call), while `decisionChannel` is the
 * channel the guardian used to respond.
 */
export function normalizeVoiceGuardianAction(ctx: VoiceGuardianActionContext): NormalizedApprovalRequest {
  return {
    assistantId: ctx.request.assistantId,
    requestId: ctx.request.id,
    requestChannel: ctx.request.sourceChannel,
    decisionChannel: ctx.decisionChannel,
    toolName: ctx.request.toolName ?? null,
    inputDigest: ctx.request.inputDigest ?? null,
    conversationId: ctx.request.sourceConversationId,
    callSessionId: ctx.request.callSessionId,
    requesterExternalUserId: null,
    guardianExternalUserId: ctx.guardianExternalUserId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Channel guardian approval adapter
// ---------------------------------------------------------------------------

export interface ChannelGuardianApprovalContext {
  /** The channel guardian approval request record. */
  approval: GuardianApprovalRequest;
  /** Channel the guardian decision arrived on. */
  decisionChannel: string;
  /** Tool invocation input digest (computed externally since the approval
   *  record does not store raw input). */
  inputDigest?: string | null;
}

/**
 * Normalize a channel guardian approval request into the unified shape.
 *
 * Channel guardian approvals originate from Telegram/SMS/WhatsApp tool-use
 * confirmation flows.  The approval record's `channel` field represents the
 * requester's channel, and `decisionChannel` is where the guardian responds.
 */
export function normalizeChannelGuardianApproval(ctx: ChannelGuardianApprovalContext): NormalizedApprovalRequest {
  return {
    assistantId: ctx.approval.assistantId,
    requestId: ctx.approval.requestId ?? ctx.approval.id,
    requestChannel: ctx.approval.channel,
    decisionChannel: ctx.decisionChannel,
    toolName: ctx.approval.toolName,
    inputDigest: ctx.inputDigest ?? null,
    conversationId: ctx.approval.conversationId,
    callSessionId: null,
    requesterExternalUserId: ctx.approval.requesterExternalUserId || null,
    guardianExternalUserId: ctx.approval.guardianExternalUserId,
  };
}
