/**
 * Shared types, constants, and utilities used across channel route modules.
 */
import { timingSafeEqual } from 'node:crypto';
import type { ChannelId } from '../../channels/types.js';
import type { GuardianRuntimeContext } from '../../daemon/session-runtime-assembly.js';
import type {
  ApprovalAction,
  ApprovalDecisionResult,
  ApprovalUIMetadata,
} from '../channel-approval-types.js';

// ---------------------------------------------------------------------------
// Gateway-origin proof
// ---------------------------------------------------------------------------

/**
 * Header name used by the gateway to prove a request originated from it.
 * The gateway sends a dedicated gateway-origin secret (or the bearer token
 * as fallback). The runtime validates it using constant-time comparison.
 * Requests to `/channels/inbound` that lack a valid proof are rejected with 403.
 */
export const GATEWAY_ORIGIN_HEADER = 'X-Gateway-Origin';

/**
 * Validate that the request carries a valid gateway-origin proof.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * The `gatewayOriginSecret` parameter is the dedicated secret configured
 * via `RUNTIME_GATEWAY_ORIGIN_SECRET`. When set, only this value is
 * accepted. When not set, the function falls back to `bearerToken` for
 * backward compatibility. When neither is configured (local dev), validation
 * is skipped entirely.
 */
export function verifyGatewayOrigin(
  req: Request,
  bearerToken?: string,
  gatewayOriginSecret?: string,
): boolean {
  // Determine the expected secret: prefer dedicated secret, fall back to bearer token
  const expectedSecret = gatewayOriginSecret ?? bearerToken;
  if (!expectedSecret) return true; // No shared secret configured — skip validation
  const provided = req.headers.get(GATEWAY_ORIGIN_HEADER);
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedSecret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Actor role
// ---------------------------------------------------------------------------

export type ActorRole = 'guardian' | 'non-guardian' | 'unverified_channel';

/** Sub-reason for `unverified_channel` denials. */
export type DenialReason = 'no_binding' | 'no_identity';

export interface GuardianContext {
  actorRole: ActorRole;
  /** The guardian's delivery chat ID (from the guardian binding). */
  guardianChatId?: string;
  /** The guardian's external user ID. */
  guardianExternalUserId?: string;
  /** Display identifier for the requester (username or external user ID). */
  requesterIdentifier?: string;
  /** The requester's external user ID. */
  requesterExternalUserId?: string;
  /** The requester's chat ID. */
  requesterChatId?: string;
  /** Sub-reason when actorRole is 'unverified_channel'. */
  denialReason?: DenialReason;
}

export function toGuardianRuntimeContext(sourceChannel: ChannelId, ctx: GuardianContext): GuardianRuntimeContext {
  return {
    sourceChannel,
    actorRole: ctx.actorRole,
    guardianChatId: ctx.guardianChatId,
    guardianExternalUserId: ctx.guardianExternalUserId,
    requesterIdentifier: ctx.requesterIdentifier,
    requesterExternalUserId: ctx.requesterExternalUserId,
    requesterChatId: ctx.requesterChatId,
    denialReason: ctx.denialReason,
  };
}

/** Guardian approval request expiry (30 minutes). */
export const GUARDIAN_APPROVAL_TTL_MS = 30 * 60 * 1000;

/**
 * Keywords the plain-text parser accepts for approval decisions. We require
 * these in generated plain-text prompts so text fallback remains actionable.
 */
export function requiredDecisionKeywords(actions: ApprovalUIMetadata['actions']): string[] {
  const hasAlways = actions.some((action) => action.id === 'approve_always');
  return hasAlways ? ['yes', 'always', 'no'] : ['yes', 'no'];
}

// ---------------------------------------------------------------------------
// Callback data parser — format: "apr:<runId>:<action>"
// ---------------------------------------------------------------------------

const VALID_ACTIONS: ReadonlySet<string> = new Set<string>([
  'approve_once',
  'approve_always',
  'reject',
]);

export function parseCallbackData(data: string): ApprovalDecisionResult | null {
  const parts = data.split(':');
  if (parts.length < 3 || parts[0] !== 'apr') return null;
  const runId = parts[1];
  const action = parts.slice(2).join(':');
  if (!runId || !VALID_ACTIONS.has(action)) return null;
  return { action: action as ApprovalAction, source: 'telegram_button', runId };
}

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

/**
 * Build contextual deny guidance for guardian-gated auto-deny paths.
 * This is passed through the confirmation pipeline so the assistant can
 * produce a single, user-facing message with next steps.
 */
export function buildGuardianDenyContext(
  toolName: string,
  denialReason: DenialReason,
  _sourceChannel: ChannelId,
): string {
  if (denialReason === 'no_identity') {
    return `Permission denied for "${toolName}": guardian approval was required, but requester identity could not be verified for this channel. In your next assistant reply, explain this clearly, avoid retrying yet, and ask the user to message from a verifiable direct account/chat before retrying.`;
  }

  return `Permission denied for "${toolName}": guardian approval was required, but no guardian is configured for this channel. In your next assistant reply, explain this and offer guardian setup. Mention that setup provides a verification token to send as /guardian_verify <token>.`;
}

export function buildPromptDeliveryFailureContext(toolName: string): string {
  return `Permission denied for "${toolName}": approval UI delivery failed and no plain-text fallback could be delivered. In your next assistant reply, apologize briefly, explain approval delivery failed, and ask the user to retry.`;
}

export function stripVerificationFailurePrefix(reason: string): string {
  const trimmed = reason.trim();
  return trimmed.replace(/^verification failed\.?\s*/i, '').trim() || trimmed;
}

// ---------------------------------------------------------------------------
// Poll constants
// ---------------------------------------------------------------------------

export const RUN_POLL_INTERVAL_MS = 500;
export const RUN_POLL_MAX_WAIT_MS = 300_000; // 5 minutes

/** Post-decision delivery poll: uses the same budget as the main poll since
 *  this is the only delivery path for late approvals after the main poll exits. */
export const POST_DECISION_POLL_INTERVAL_MS = 500;
export const POST_DECISION_POLL_MAX_WAIT_MS = RUN_POLL_MAX_WAIT_MS;

/**
 * Override the poll max-wait for tests. When set, used in place of
 * RUN_POLL_MAX_WAIT_MS so tests can exercise timeout paths without
 * waiting 5 minutes.
 */
let testPollMaxWaitOverride: number | null = null;

/** @internal — test-only: set an override for the poll max-wait. */
export function _setTestPollMaxWait(ms: number | null): void {
  testPollMaxWaitOverride = ms;
}

export function getEffectivePollMaxWait(): number {
  return testPollMaxWaitOverride ?? RUN_POLL_MAX_WAIT_MS;
}
