/**
 * Shared verification-session contracts for the gateway-native session
 * lifecycle (Combo 13).
 *
 * The secret-hashing helper lives here so gateway-computed hashes match
 * assistant-minted (and backfilled) hashes byte-for-byte — hash compatibility
 * with rows already stored in the session table is load-bearing, so do not
 * change the scheme. The wire DTO and the `verification_sessions_*` IPC
 * request/response schemas are shared so gateway and daemon converge on one
 * source of truth instead of drifting copies.
 *
 * Method names deliberately use the `verification_sessions_` prefix — the
 * daemon's client-facing HTTP/CLI surface owns the distinct
 * `channel_verification_sessions_*` operationIds.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

// ---------------------------------------------------------------------------
// Hash helper
// ---------------------------------------------------------------------------

/**
 * SHA-256 hash a verification secret (challenge code or bootstrap token) for
 * storage comparison. Must remain stable: stored session rows hold
 * `challenge_hash` / `bootstrap_token_hash` values produced by this scheme
 * (`assistant/src/runtime/channel-verification-service.ts` hashSecret).
 */
export function hashVerificationSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const SESSION_STATUS_VALUES = [
  "pending",
  "consumed",
  "pending_bootstrap",
  "awaiting_response",
  "verified",
  "expired",
  "revoked",
  "locked",
] as const;

export const SessionStatusSchema = z.enum(SESSION_STATUS_VALUES);

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const VERIFICATION_PURPOSE_VALUES = [
  "guardian",
  "trusted_contact",
] as const;

export const VerificationPurposeSchema = z.enum(VERIFICATION_PURPOSE_VALUES);

export type VerificationPurpose = z.infer<typeof VerificationPurposeSchema>;

export const IDENTITY_BINDING_STATUS_VALUES = [
  "pending_bootstrap",
  "bound",
] as const;

export const IdentityBindingStatusSchema = z.enum(
  IDENTITY_BINDING_STATUS_VALUES,
);

export type IdentityBindingStatus = z.infer<typeof IdentityBindingStatusSchema>;

// ---------------------------------------------------------------------------
// Wire DTO
// ---------------------------------------------------------------------------

/**
 * Verification session as carried on the daemon ↔ gateway wire. Mirrors the
 * daemon's `VerificationSession` interface
 * (`assistant/src/channels/channel-verification-sessions.ts`) field-for-field
 * so consumer flips are mechanical.
 */
export const VerificationSessionSchema = z.object({
  id: z.string(),
  channel: z.string(),
  challengeHash: z.string(),
  expiresAt: z.number(),
  status: SessionStatusSchema,
  sourceConversationId: z.string().nullable(),
  consumedByExternalUserId: z.string().nullable(),
  consumedByChatId: z.string().nullable(),
  // Outbound session: expected-identity binding
  expectedExternalUserId: z.string().nullable(),
  expectedChatId: z.string().nullable(),
  expectedPhoneE164: z.string().nullable(),
  identityBindingStatus: IdentityBindingStatusSchema.nullable(),
  // Outbound session: delivery tracking
  destinationAddress: z.string().nullable(),
  lastSentAt: z.number().nullable(),
  sendCount: z.number().int(),
  nextResendAt: z.number().nullable(),
  // Session configuration
  codeDigits: z.number().int(),
  maxAttempts: z.number().int(),
  verificationPurpose: VerificationPurposeSchema,
  // Telegram bootstrap deep-link token hash
  bootstrapTokenHash: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type VerificationSessionWire = z.infer<typeof VerificationSessionSchema>;

// ---------------------------------------------------------------------------
// IPC methods
// ---------------------------------------------------------------------------

/**
 * Gateway IPC method names for the verification-session lifecycle. Keys match
 * the daemon-side wrapper names; values are the wire method strings.
 */
export const VERIFICATION_SESSIONS_IPC_METHODS = {
  createInbound: "verification_sessions_create_inbound",
  createOutbound: "verification_sessions_create_outbound",
  getPending: "verification_sessions_get_pending",
  findActive: "verification_sessions_find_active",
  resolveBootstrap: "verification_sessions_resolve_bootstrap",
  bindIdentity: "verification_sessions_bind_identity",
  updateStatus: "verification_sessions_update_status",
  updateDelivery: "verification_sessions_update_delivery",
  countRecentSends: "verification_sessions_count_recent_sends",
  revokePending: "verification_sessions_revoke_pending",
  validateConsume: "verification_sessions_validate_consume",
} as const;

export type VerificationSessionsIpcMethod =
  (typeof VERIFICATION_SESSIONS_IPC_METHODS)[keyof typeof VERIFICATION_SESSIONS_IPC_METHODS];

// ---------------------------------------------------------------------------
// IPC request/response schemas
// ---------------------------------------------------------------------------

/**
 * Shared response for session lookups (`verification_sessions_get_pending`,
 * `_find_active`, `_resolve_bootstrap`): the wire DTO, or null when no
 * matching session exists.
 */
export const SessionLookupIpcResponseSchema =
  VerificationSessionSchema.nullable();

export type SessionLookupIpcResponse = z.infer<
  typeof SessionLookupIpcResponseSchema
>;

/** Shared minimal ack for session mutations. */
export const SessionMutationIpcResponseSchema = z.object({
  ok: z.boolean(),
});

export type SessionMutationIpcResponse = z.infer<
  typeof SessionMutationIpcResponseSchema
>;

/** Request for `verification_sessions_create_inbound`. */
export const CreateInboundSessionIpcParamsSchema = z.object({
  channel: z.string().min(1),
  sourceConversationId: z.string().optional(),
});

export type CreateInboundSessionIpcParams = z.infer<
  typeof CreateInboundSessionIpcParamsSchema
>;

/**
 * Response for `verification_sessions_create_inbound`. Carries the raw
 * secret: message composition and channel delivery are daemon-owned, so the
 * secret must transit back (the daemon composes the instruction copy —
 * mirror of how invite mint returns data and the daemon presents it).
 */
export const CreateInboundSessionIpcResponseSchema = z.object({
  session: VerificationSessionSchema,
  secret: z.string(),
  verifyCommand: z.string(),
  ttlSeconds: z.number(),
});

export type CreateInboundSessionIpcResponse = z.infer<
  typeof CreateInboundSessionIpcResponseSchema
>;

/** Request for `verification_sessions_create_outbound`. */
export const CreateOutboundSessionIpcParamsSchema = z.object({
  channel: z.string().min(1),
  expectedExternalUserId: z.string().optional(),
  expectedChatId: z.string().optional(),
  expectedPhoneE164: z.string().optional(),
  identityBindingStatus: IdentityBindingStatusSchema.optional(),
  destinationAddress: z.string().optional(),
  codeDigits: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
  verificationPurpose: VerificationPurposeSchema.optional(),
  bootstrapTokenHash: z.string().optional(),
  // Caller-supplied id (bootstrap flows pre-mint the id for deep links).
  sessionId: z.string().optional(),
  // Atomic claim guards (optional, additive). Checked gateway-side in the
  // same synchronous section as the revoke-prior+insert, so a stale caller
  // gets a conflict instead of revoking a fresher session's code.
  // Mint only if this source session is still `pending_bootstrap`.
  requireSourceSessionPending: z.string().min(1).optional(),
  // Mint only if the channel has no active (pending_bootstrap /
  // awaiting_response, non-expired) session.
  ifNoneActive: z.boolean().optional(),
});

export type CreateOutboundSessionIpcParams = z.infer<
  typeof CreateOutboundSessionIpcParamsSchema
>;

/**
 * Response for `verification_sessions_create_outbound`. Mirrors the daemon's
 * `CreateOutboundSessionResult` so consumer flips are mechanical; `secret`
 * transits for daemon-owned delivery.
 */
export const CreateOutboundSessionIpcResponseSchema = z.object({
  sessionId: z.string(),
  secret: z.string(),
  challengeHash: z.string(),
  expiresAt: z.number(),
  ttlSeconds: z.number(),
});

export type CreateOutboundSessionIpcResponse = z.infer<
  typeof CreateOutboundSessionIpcResponseSchema
>;

/**
 * Conflict marker returned by `verification_sessions_create_outbound` when a
 * claim guard (`requireSourceSessionPending` / `ifNoneActive`) fails. Only
 * reachable when a guard was passed — legacy callers never see this shape.
 */
export const CreateOutboundSessionConflictSchema = z.object({
  conflict: z.literal(true),
  reason: z.enum(["source_session_not_pending", "active_session_exists"]),
});

export type CreateOutboundSessionConflict = z.infer<
  typeof CreateOutboundSessionConflictSchema
>;

/** Response for guarded `verification_sessions_create_outbound` calls. */
export const CreateOutboundSessionConditionalIpcResponseSchema = z.union([
  CreateOutboundSessionConflictSchema,
  CreateOutboundSessionIpcResponseSchema,
]);

export type CreateOutboundSessionConditionalIpcResponse = z.infer<
  typeof CreateOutboundSessionConditionalIpcResponseSchema
>;

const ChannelOnlyIpcParamsSchema = z.object({
  channel: z.string().min(1),
});

/** Request for `verification_sessions_get_pending` (status `pending` only). */
export const GetPendingSessionIpcParamsSchema = ChannelOnlyIpcParamsSchema;

export type GetPendingSessionIpcParams = z.infer<
  typeof GetPendingSessionIpcParamsSchema
>;

/**
 * Request for `verification_sessions_find_active` (statuses
 * `pending_bootstrap`/`awaiting_response`, newest first).
 */
export const FindActiveSessionIpcParamsSchema = ChannelOnlyIpcParamsSchema;

export type FindActiveSessionIpcParams = z.infer<
  typeof FindActiveSessionIpcParamsSchema
>;

/**
 * Request for `verification_sessions_resolve_bootstrap`. Carries the RAW
 * deep-link token; the gateway hashes it (`hashVerificationSecret`) and looks
 * up by `bootstrap_token_hash`.
 */
export const ResolveBootstrapSessionIpcParamsSchema = z.object({
  channel: z.string().min(1),
  token: z.string().min(1),
});

export type ResolveBootstrapSessionIpcParams = z.infer<
  typeof ResolveBootstrapSessionIpcParamsSchema
>;

/** Request for `verification_sessions_bind_identity`. */
export const BindSessionIdentityIpcParamsSchema = z.object({
  sessionId: z.string().min(1),
  externalUserId: z.string().min(1),
  chatId: z.string().min(1),
});

export type BindSessionIdentityIpcParams = z.infer<
  typeof BindSessionIdentityIpcParamsSchema
>;

/** Request for `verification_sessions_update_status`. */
export const UpdateSessionStatusIpcParamsSchema = z.object({
  sessionId: z.string().min(1),
  status: SessionStatusSchema,
  consumedByExternalUserId: z.string().optional(),
  consumedByChatId: z.string().optional(),
});

export type UpdateSessionStatusIpcParams = z.infer<
  typeof UpdateSessionStatusIpcParamsSchema
>;

/** Request for `verification_sessions_update_delivery`. */
export const UpdateSessionDeliveryIpcParamsSchema = z.object({
  sessionId: z.string().min(1),
  lastSentAt: z.number(),
  sendCount: z.number().int(),
  nextResendAt: z.number().nullable(),
});

export type UpdateSessionDeliveryIpcParams = z.infer<
  typeof UpdateSessionDeliveryIpcParamsSchema
>;

/** Request for `verification_sessions_count_recent_sends`. */
export const CountRecentSendsIpcParamsSchema = z.object({
  channel: z.string().min(1),
  destinationAddress: z.string().min(1),
  windowMs: z.number().positive(),
});

export type CountRecentSendsIpcParams = z.infer<
  typeof CountRecentSendsIpcParamsSchema
>;

/** Response for `verification_sessions_count_recent_sends`. */
export const CountRecentSendsIpcResponseSchema = z.object({
  count: z.number().int(),
});

export type CountRecentSendsIpcResponse = z.infer<
  typeof CountRecentSendsIpcResponseSchema
>;

/** Request for `verification_sessions_revoke_pending`. */
export const RevokePendingSessionsIpcParamsSchema = ChannelOnlyIpcParamsSchema;

export type RevokePendingSessionsIpcParams = z.infer<
  typeof RevokePendingSessionsIpcParamsSchema
>;

/**
 * Request for `verification_sessions_validate_consume` — the gateway-native
 * validate+consume path (rate limiting, identity binding, status-guarded
 * consume, in-engine role side effects).
 */
export const ValidateConsumeSessionIpcParamsSchema = z.object({
  channel: z.string().min(1),
  secret: z.string().min(1),
  actorExternalUserId: z.string(),
  actorChatId: z.string(),
});

export type ValidateConsumeSessionIpcParams = z.infer<
  typeof ValidateConsumeSessionIpcParamsSchema
>;

/**
 * Response for `verification_sessions_validate_consume`. On failure `reason`
 * is a machine-readable code — user-facing copy is composed daemon-side.
 */
export const ValidateConsumeSessionIpcResponseSchema = z.discriminatedUnion(
  "success",
  [
    z.object({
      success: z.literal(true),
      verificationType: VerificationPurposeSchema,
    }),
    z.object({
      success: z.literal(false),
      reason: z.string(),
    }),
  ],
);

export type ValidateConsumeSessionIpcResponse = z.infer<
  typeof ValidateConsumeSessionIpcResponseSchema
>;
