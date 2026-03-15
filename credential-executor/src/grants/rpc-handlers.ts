/**
 * CES RPC handlers for grant and audit management.
 *
 * Implements the server-side handlers for:
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
  RevokeGrant,
  RevokeGrantResponse,
  ListAuditRecords,
  ListAuditRecordsResponse,
  PersistentGrantRecord,
} from "@vellumai/ces-contracts";

import type { PersistentGrantStore, PersistentGrant } from "./persistent-store.js";
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
    credentialHandle: grant.tool,
    proposalType: "http",
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
