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
import type { TemporaryGrantStore } from "./temporary-store.js";
import type { AuditStore } from "../audit/store.js";
import type { RpcMethodHandler } from "../server.js";

// ---------------------------------------------------------------------------
// Grant → PersistentGrantRecord projection
// ---------------------------------------------------------------------------

/**
 * Project a CES internal PersistentGrant into the wire-format
 * PersistentGrantRecord. The internal store uses a simpler schema;
 * the wire format includes additional status/lifecycle fields.
 *
 * Since the persistent store does not track lifecycle states (expiry,
 * revocation, consumption), all persisted grants are considered "active".
 */
function projectGrant(
  grant: PersistentGrant,
  sessionId: string,
): PersistentGrantRecord {
  return {
    grantId: grant.id,
    sessionId,
    credentialHandle: grant.scope,
    proposalType:
      grant.tool === "http" || grant.tool === "command"
        ? grant.tool
        : "command",
    proposalHash: grant.id,
    allowedPurposes: [grant.pattern],
    status: "active",
    grantedBy: "user",
    createdAt: new Date(grant.createdAt).toISOString(),
    expiresAt: null,
    consumedAt: null,
    revokedAt: null,
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
      const persistentGrant: PersistentGrant = {
        id: grantId,
        tool: proposal.type,
        pattern:
          proposal.type === "http"
            ? `${proposal.method} ${proposal.url}`
            : proposal.command,
        scope: proposal.credentialHandle,
        createdAt: now,
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
        conversationId: sessionId,
      });
      // Also add an allow_once fallback: the HTTP executor doesn't pass
      // conversationId, so the thread-scoped grant alone is unreachable
      // for HTTP requests. The allow_once ensures the immediate retry
      // succeeds regardless of executor type.
      deps.temporaryGrantStore.add("allow_once", decision.proposalHash);
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
  /** Default session ID for grants that don't track session. */
  sessionId: string;
}

/**
 * Create an RPC handler for the `list_grants` method.
 *
 * Lists all persistent grants, optionally filtered by session ID,
 * credential handle, or status. Returns wire-format PersistentGrantRecords
 * that never include raw secret material.
 */
export function createListGrantsHandler(
  deps: ListGrantsHandlerDeps,
): RpcMethodHandler<ListGrants, ListGrantsResponse> {
  return (request) => {
    const allGrants = deps.persistentGrantStore.getAll();
    const projected = allGrants.map((g) => projectGrant(g, deps.sessionId));

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
 * Removes a grant from the persistent store by its stable ID. Returns
 * success/failure. The reason field is logged but not persisted (the
 * persistent store does not track revocation metadata).
 */
export function createRevokeGrantHandler(
  deps: RevokeGrantHandlerDeps,
): RpcMethodHandler<RevokeGrant, RevokeGrantResponse> {
  return (request) => {
    const removed = deps.persistentGrantStore.remove(request.grantId);

    if (!removed) {
      return {
        success: false,
        error: {
          code: "GRANT_NOT_FOUND",
          message: `No grant found with ID "${request.grantId}"`,
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
