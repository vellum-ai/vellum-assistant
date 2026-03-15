/**
 * CES RPC handlers for grant and audit management.
 *
 * Implements the server-side handlers for:
 * - `record_grant` — Record a grant decision after guardian approval.
 * - `list_grants` — List grants filtered by session, handle, or status.
 * - `revoke_grant` — Revoke a specific grant by its stable ID.
 * - `list_audit_records` — List audit records with filtering and pagination.
 *
 * All handlers operate strictly on CES-owned state and never expose raw
 * secret material, raw tokens, or raw headers/bodies. Grant records returned
 * to the assistant contain only metadata (handle, proposal type, status,
 * timestamps).
 */

import type {
  ListGrants,
  ListGrantsResponse,
  RecordGrant,
  RecordGrantResponse,
  RevokeGrant,
  RevokeGrantResponse,
  ListAuditRecords,
  ListAuditRecordsResponse,
  PersistentGrantRecord,
} from "@vellumai/ces-contracts";

import type { PersistentGrantStore, PersistentGrant } from "./persistent-store.js";
import { type TemporaryGrantStore, DEFAULT_ONCE_FALLBACK_TTL_MS } from "./temporary-store.js";
import type { AuditStore } from "../audit/store.js";
import type { RpcMethodHandler } from "../server.js";

// ---------------------------------------------------------------------------
// Grant → PersistentGrantRecord projection
// ---------------------------------------------------------------------------

/**
 * Project a CES internal PersistentGrant into the wire-format
 * PersistentGrantRecord. Maps real fields from the persistent store
 * schema into the wire contract.
 */
function projectGrant(grant: PersistentGrant): PersistentGrantRecord {
  return {
    grantId: grant.id,
    sessionId: grant.sessionId,
    credentialHandle: grant.scope,
    proposalType:
      grant.tool === "http" || grant.tool === "command"
        ? grant.tool
        : "command",
    proposalHash: grant.id,
    allowedPurposes: [grant.pattern],
    status: grant.revokedAt != null ? "revoked" : "active",
    grantedBy: "user",
    createdAt: new Date(grant.createdAt).toISOString(),
    expiresAt: null,
    consumedAt: null,
    revokedAt:
      grant.revokedAt != null
        ? new Date(grant.revokedAt).toISOString()
        : null,
  };
}

// ---------------------------------------------------------------------------
// record_grant handler
// ---------------------------------------------------------------------------

export interface RecordGrantHandlerDeps {
  persistentGrantStore: PersistentGrantStore;
  temporaryGrantStore: TemporaryGrantStore;
}

/**
 * Create an RPC handler for the `record_grant` method.
 *
 * Receives a `TemporaryGrantDecision` from the approval bridge and persists
 * it as a `PersistentGrant` (for approved decisions) or returns a success
 * acknowledgement (for denied decisions). The handler also adds an
 * in-memory temporary grant so the caller can immediately retry the
 * original tool invocation.
 *
 * For approved decisions with a TTL of "PT10M", the grant is stored as
 * a timed temporary grant. Otherwise it is persisted as a permanent grant.
 */
export function createRecordGrantHandler(
  deps: RecordGrantHandlerDeps,
): RpcMethodHandler<RecordGrant, RecordGrantResponse> {
  return (request) => {
    const { decision, sessionId } = request;

    // Denied decisions are acknowledged but produce no grant record.
    if (decision.decision === "denied") {
      return { success: true };
    }

    const proposal = decision.proposal;
    const now = Date.now();
    const grantId = decision.proposalHash;

    // Determine the grant type. When omitted (backwards compat), default
    // to `always_allow` so existing callers that don't send `grantType`
    // continue to create persistent grants.
    const grantType = decision.grantType ?? "always_allow";

    // Only `always_allow` creates a persistent grant. All other approved
    // decisions create only a temporary grant — this prevents allow_once,
    // allow_10m, and allow_thread from becoming effectively permanent.
    if (grantType === "always_allow") {
      let pattern: string;
      if (proposal.type === "http") {
        // Use the templated allowedUrlPatterns (e.g. "https://api.example.com/repos/{:uuid}/pulls")
        // so the persistent grant covers future requests with different IDs but the same URL structure.
        // Falls back to the exact URL only if allowedUrlPatterns is missing.
        const urlPattern = proposal.allowedUrlPatterns?.[0] ?? proposal.url;
        pattern = `${proposal.method} ${urlPattern}`;
      } else {
        pattern = proposal.allowedCommandPatterns?.[0] ?? proposal.command;
      }
      const persistentGrant: PersistentGrant = {
        id: grantId,
        tool: proposal.type,
        pattern,
        scope: proposal.credentialHandle,
        createdAt: now,
        sessionId,
      };
      deps.persistentGrantStore.add(persistentGrant);
    }

    // Record a temporary grant so the caller can use it immediately.
    // For `always_allow`, an `allow_once` temp grant bridges the gap until
    // the next policy check hits the persistent store.
    if (grantType === "allow_10m") {
      deps.temporaryGrantStore.add("allow_10m", decision.proposalHash);
    } else if (grantType === "allow_thread") {
      deps.temporaryGrantStore.add("allow_thread", decision.proposalHash, {
        conversationId: request.conversationId ?? sessionId,
      });
      // Also add an allow_once fallback as defense-in-depth: ensures the
      // immediate retry succeeds even if conversationId is missing or
      // mismatched. TTL-scoped to prevent cross-thread consumption outside
      // the immediate retry window.
      deps.temporaryGrantStore.add("allow_once", decision.proposalHash, {
        durationMs: DEFAULT_ONCE_FALLBACK_TTL_MS,
      });
    } else {
      // allow_once and always_allow both get a single-use temp grant
      // for immediate retry.
      deps.temporaryGrantStore.add("allow_once", decision.proposalHash);
    }

    // Compute expiry from TTL if present.
    let expiresAt: string | null = null;
    if (decision.ttl === "PT10M") {
      expiresAt = new Date(now + 10 * 60 * 1000).toISOString();
    }

    const grantRecord: PersistentGrantRecord = {
      grantId,
      sessionId,
      credentialHandle: proposal.credentialHandle,
      proposalType: proposal.type,
      proposalHash: decision.proposalHash,
      allowedPurposes:
        proposal.type === "http"
          ? proposal.allowedUrlPatterns ?? [`${proposal.method} ${proposal.url}`]
          : proposal.allowedCommandPatterns ?? [proposal.command],
      status: "active",
      grantedBy: decision.decidedBy,
      createdAt: new Date(now).toISOString(),
      expiresAt,
      consumedAt: null,
      revokedAt: null,
    };

    return {
      success: true,
      grant: grantRecord,
    };
  };
}

// ---------------------------------------------------------------------------
// list_grants handler
// ---------------------------------------------------------------------------

export interface ListGrantsHandlerDeps {
  persistentGrantStore: PersistentGrantStore;
}

/**
 * Create an RPC handler for the `list_grants` method.
 *
 * Lists all persistent grants (including revoked, for audit trail),
 * optionally filtered by session ID, credential handle, or status.
 * Returns wire-format PersistentGrantRecords that never include raw
 * secret material.
 */
export function createListGrantsHandler(
  deps: ListGrantsHandlerDeps,
): RpcMethodHandler<ListGrants, ListGrantsResponse> {
  return (request) => {
    // Include revoked grants in the listing for audit visibility.
    const allGrants = deps.persistentGrantStore.getAllIncludingRevoked();
    const projected = allGrants.map((g) => projectGrant(g));

    let filtered = projected;

    if (request.sessionId) {
      filtered = filtered.filter((g) => g.sessionId === request.sessionId);
    }

    if (request.credentialHandle) {
      filtered = filtered.filter(
        (g) => g.credentialHandle === request.credentialHandle,
      );
    }

    if (request.status) {
      filtered = filtered.filter((g) => g.status === request.status);
    }

    return { grants: filtered };
  };
}

// ---------------------------------------------------------------------------
// revoke_grant handler
// ---------------------------------------------------------------------------

export interface RevokeGrantHandlerDeps {
  persistentGrantStore: PersistentGrantStore;
}

/**
 * Create an RPC handler for the `revoke_grant` method.
 *
 * Marks a grant as revoked in the persistent store by its stable ID,
 * preserving the record for audit trail. Returns success/failure.
 */
export function createRevokeGrantHandler(
  deps: RevokeGrantHandlerDeps,
): RpcMethodHandler<RevokeGrant, RevokeGrantResponse> {
  return (request) => {
    const revoked = deps.persistentGrantStore.markRevoked(
      request.grantId,
      request.reason,
    );

    if (!revoked) {
      return {
        success: false,
        error: {
          code: "GRANT_NOT_FOUND",
          message: `No grant found with ID "${request.grantId}" (or already revoked)`,
        },
      };
    }

    return { success: true };
  };
}

// ---------------------------------------------------------------------------
// list_audit_records handler
// ---------------------------------------------------------------------------

export interface ListAuditRecordsHandlerDeps {
  auditStore: AuditStore;
}

/**
 * Create an RPC handler for the `list_audit_records` method.
 *
 * Lists audit records with optional filtering by session, credential
 * handle, or grant ID. Supports limit and cursor-based pagination.
 *
 * Audit records never contain raw secrets, raw tokens, or raw
 * headers/bodies — they are token-free summaries generated at
 * execution time.
 */
export function createListAuditRecordsHandler(
  deps: ListAuditRecordsHandlerDeps,
): RpcMethodHandler<ListAuditRecords, ListAuditRecordsResponse> {
  return (request) => {
    const result = deps.auditStore.list({
      sessionId: request.sessionId,
      credentialHandle: request.credentialHandle,
      grantId: request.grantId,
      limit: request.limit,
      cursor: request.cursor,
    });

    return {
      records: result.records,
      nextCursor: result.nextCursor,
    };
  };
}
