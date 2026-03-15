/**
 * CES grant proposal, grant record, and audit record schemas.
 *
 * These schemas define the wire format for:
 * - HTTP grant proposals (requesting permission to make an authenticated HTTP call)
 * - Command grant proposals (requesting permission to run an authenticated command)
 * - Temporary grant decisions (approval/denial from a guardian)
 * - Persistent grant records (stored by CES after approval)
 * - Audit record summaries (materialization events)
 */

import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Grant proposal types
// ---------------------------------------------------------------------------

/**
 * Proposal to make an authenticated HTTP request using a credential.
 */
export const HttpGrantProposalSchema = z.object({
  type: z.literal("http"),
  /** CES credential handle identifying which credential to use. */
  credentialHandle: z.string(),
  /** HTTP method (e.g. "GET", "POST"). */
  method: z.string(),
  /** Target URL. */
  url: z.string(),
  /** Human-readable description of why this request is needed. */
  purpose: z.string(),
  /** Optional constrained set of URL patterns this grant covers. */
  allowedUrlPatterns: z.array(z.string()).optional(),
});
export type HttpGrantProposal = z.infer<typeof HttpGrantProposalSchema>;

/**
 * Proposal to run an authenticated command using credential environment variables.
 */
export const CommandGrantProposalSchema = z.object({
  type: z.literal("command"),
  /** CES credential handle identifying which credential to use. */
  credentialHandle: z.string(),
  /** The command to execute (without credential values — CES injects those). */
  command: z.string(),
  /** Human-readable description of why this command is needed. */
  purpose: z.string(),
  /** Optional constrained set of command patterns this grant covers. */
  allowedCommandPatterns: z.array(z.string()).optional(),
});
export type CommandGrantProposal = z.infer<typeof CommandGrantProposalSchema>;

/**
 * Union of all grant proposal types.
 */
export const GrantProposalSchema = z.discriminatedUnion("type", [
  HttpGrantProposalSchema,
  CommandGrantProposalSchema,
]);
export type GrantProposal = z.infer<typeof GrantProposalSchema>;

// ---------------------------------------------------------------------------
// Grant decisions (temporary — before persistence)
// ---------------------------------------------------------------------------

export const GrantDecision = {
  Approved: "approved",
  Denied: "denied",
} as const;

export type GrantDecision = (typeof GrantDecision)[keyof typeof GrantDecision];

/**
 * A temporary grant decision from a guardian, before CES persists it.
 */
export const TemporaryGrantDecisionSchema = z.object({
  /** The proposal this decision applies to. */
  proposal: GrantProposalSchema,
  /** Deterministic hash of the proposal (see rendering.ts). */
  proposalHash: z.string(),
  /** The guardian's decision. */
  decision: z.enum(["approved", "denied"]),
  /** Who made the decision (guardian identifier). */
  decidedBy: z.string(),
  /** ISO-8601 timestamp of the decision. */
  decidedAt: z.string(),
  /** Optional human-readable reason for the decision. */
  reason: z.string().optional(),
  /** How long the grant should remain valid (ISO-8601 duration, e.g. "PT1H"). */
  ttl: z.string().optional(),
  /**
   * The type of grant to create. Determines persistence behaviour:
   * - `allow_once`: Temporary single-use grant (consumed after one use)
   * - `allow_10m`: Temporary timed grant (10-minute TTL)
   * - `allow_conversation`: Temporary conversation-scoped grant (lives for session)
   * - `always_allow`: Persistent grant (survives restart)
   *
   * When omitted, defaults to `always_allow` for backwards compatibility.
   */
  grantType: z.enum(["allow_once", "allow_10m", "allow_conversation", "always_allow"]).optional(),
});
export type TemporaryGrantDecision = z.infer<
  typeof TemporaryGrantDecisionSchema
>;

// ---------------------------------------------------------------------------
// Persistent grant records (CES-owned)
// ---------------------------------------------------------------------------

export const GrantStatus = {
  Active: "active",
  Expired: "expired",
  Revoked: "revoked",
  Consumed: "consumed",
} as const;

export type GrantStatus = (typeof GrantStatus)[keyof typeof GrantStatus];

/**
 * A persistent grant record stored by CES.
 *
 * Grants authorize a specific agent session to use a credential for a
 * constrained purpose. They are never sent to the assistant with secret
 * values — only metadata.
 */
export const PersistentGrantRecordSchema = z.object({
  /** Unique grant identifier. */
  grantId: z.string(),
  /** The agent session that holds this grant. */
  sessionId: z.string(),
  /** The credential handle this grant authorizes. */
  credentialHandle: z.string(),
  /** The proposal type (http or command). */
  proposalType: z.enum(["http", "command"]),
  /** Deterministic hash of the original proposal. */
  proposalHash: z.string(),
  /** Constrained purposes — URL patterns for HTTP, command patterns for commands. */
  allowedPurposes: z.array(z.string()),
  /** Current grant status. */
  status: z.enum(["active", "expired", "revoked", "consumed"]),
  /** Who approved the grant. */
  grantedBy: z.string(),
  /** ISO-8601 timestamp when the grant was created. */
  createdAt: z.string(),
  /** ISO-8601 timestamp when the grant expires (null if no expiry). */
  expiresAt: z.string().nullable(),
  /** ISO-8601 timestamp when the grant was consumed (null if unconsumed). */
  consumedAt: z.string().nullable(),
  /** ISO-8601 timestamp when the grant was revoked (null if active). */
  revokedAt: z.string().nullable(),
});
export type PersistentGrantRecord = z.infer<typeof PersistentGrantRecordSchema>;

// ---------------------------------------------------------------------------
// Audit record summaries
// ---------------------------------------------------------------------------

/**
 * Summary of a credential materialization event, as exposed by CES
 * for audit inspection.
 *
 * Audit records never contain secret values — only metadata about what
 * was accessed, when, by whom, and whether it succeeded.
 */
export const AuditRecordSummarySchema = z.object({
  /** Unique audit record identifier. */
  auditId: z.string(),
  /** The grant that authorized this materialization. */
  grantId: z.string(),
  /** The credential handle that was materialized. */
  credentialHandle: z.string(),
  /** The tool that triggered materialization. */
  toolName: z.string(),
  /** Target of the operation (URL for HTTP, command summary for commands). */
  target: z.string(),
  /** The agent session that triggered materialization. */
  sessionId: z.string(),
  /** Whether the execution succeeded. */
  success: z.boolean(),
  /** Error message if execution failed (no secrets). */
  errorMessage: z.string().optional(),
  /** ISO-8601 timestamp of the materialization event. */
  timestamp: z.string(),
});
export type AuditRecordSummary = z.infer<typeof AuditRecordSummarySchema>;
