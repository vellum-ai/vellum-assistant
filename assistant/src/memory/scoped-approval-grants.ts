/**
 * CRUD and atomic consume for scoped approval grants.
 *
 * Grants authorise exactly one tool execution.  Two scope modes exist:
 *   - `request_id`      — grant is bound to a specific pending request
 *   - `tool_signature`  — grant is bound to a tool name + input digest
 *
 * Invariants:
 *   - At most one successful consume per grant (CAS: active -> consumed).
 *   - Matching requires all non-null scope fields to match exactly.
 *   - Expired and revoked grants cannot be consumed.
 */

import { and, eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getLogger } from "../util/logger.js";
import { getDb, rawChanges } from "./db.js";
import { scopedApprovalGrants } from "./schema.js";

const log = getLogger("scoped-approval-grants");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScopeMode = "request_id" | "tool_signature";
export type GrantStatus = "active" | "consumed" | "expired" | "revoked";

export interface ScopedApprovalGrant {
  id: string;
  scopeMode: ScopeMode;
  requestId: string | null;
  toolName: string | null;
  inputDigest: string | null;
  requestChannel: string;
  decisionChannel: string;
  executionChannel: string | null;
  conversationId: string | null;
  callSessionId: string | null;
  requesterExternalUserId: string | null;
  guardianExternalUserId: string | null;
  status: GrantStatus;
  expiresAt: number;
  consumedAt: number | null;
  consumedByRequestId: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max CAS retry attempts when a concurrent consumer steals the selected candidate. */
const MAX_CAS_RETRIES = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToGrant(
  row: typeof scopedApprovalGrants.$inferSelect,
): ScopedApprovalGrant {
  return {
    id: row.id,
    scopeMode: row.scopeMode as ScopeMode,
    requestId: row.requestId,
    toolName: row.toolName,
    inputDigest: row.inputDigest,
    requestChannel: row.requestChannel,
    decisionChannel: row.decisionChannel,
    executionChannel: row.executionChannel,
    conversationId: row.conversationId,
    callSessionId: row.callSessionId,
    requesterExternalUserId: row.requesterExternalUserId,
    guardianExternalUserId: row.guardianExternalUserId,
    status: row.status as GrantStatus,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    consumedByRequestId: row.consumedByRequestId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateScopedApprovalGrantParams {
  scopeMode: ScopeMode;
  requestId?: string | null;
  toolName?: string | null;
  inputDigest?: string | null;
  requestChannel: string;
  decisionChannel: string;
  executionChannel?: string | null;
  conversationId?: string | null;
  callSessionId?: string | null;
  requesterExternalUserId?: string | null;
  guardianExternalUserId?: string | null;
  expiresAt: number;
}

function createScopedApprovalGrant(
  params: CreateScopedApprovalGrantParams,
): ScopedApprovalGrant {
  const db = getDb();
  const now = Date.now();
  const id = uuid();

  const row = {
    id,
    scopeMode: params.scopeMode,
    requestId: params.requestId ?? null,
    toolName: params.toolName ?? null,
    inputDigest: params.inputDigest ?? null,
    requestChannel: params.requestChannel,
    decisionChannel: params.decisionChannel,
    executionChannel: params.executionChannel ?? null,
    conversationId: params.conversationId ?? null,
    callSessionId: params.callSessionId ?? null,
    requesterExternalUserId: params.requesterExternalUserId ?? null,
    guardianExternalUserId: params.guardianExternalUserId ?? null,
    status: "active" as const,
    expiresAt: params.expiresAt,
    consumedAt: null,
    consumedByRequestId: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(scopedApprovalGrants).values(row).run();

  log.info(
    {
      event: "scoped_grant_created",
      grantId: id,
      scopeMode: params.scopeMode,
      toolName: params.toolName ?? null,
      requestChannel: params.requestChannel,
      decisionChannel: params.decisionChannel,
      executionChannel: params.executionChannel ?? null,
      expiresAt: params.expiresAt,
    },
    "Scoped approval grant created",
  );

  return rowToGrant(row);
}

// ---------------------------------------------------------------------------
// Consume by request ID (CAS: active -> consumed)
// ---------------------------------------------------------------------------

export interface ConsumeByRequestIdResult {
  ok: boolean;
  grant: ScopedApprovalGrant | null;
}

/**
 * Atomically consume a grant by request ID.
 *
 * Only succeeds when exactly one active, non-expired grant matches the
 * given `requestId`.  Uses compare-and-swap on the `status` column so
 * concurrent consumers race safely — at most one wins.
 */
function consumeScopedApprovalGrantByRequestId(
  requestId: string,
  consumingRequestId: string,
  now?: number,
): ConsumeByRequestIdResult {
  const db = getDb();
  const currentTime = now ?? Date.now();

  // Two-step select-then-update with LIMIT 1 to consume exactly one grant
  // even if duplicate rows exist (the index on request_id is non-unique).
  for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt++) {
    const candidate = db
      .select({ id: scopedApprovalGrants.id })
      .from(scopedApprovalGrants)
      .where(
        and(
          eq(scopedApprovalGrants.requestId, requestId),
          eq(scopedApprovalGrants.scopeMode, "request_id"),
          eq(scopedApprovalGrants.status, "active"),
          sql`${scopedApprovalGrants.expiresAt} > ${currentTime}`,
        ),
      )
      .limit(1)
      .get();

    if (!candidate) {
      log.info(
        {
          event: "scoped_grant_consume_miss",
          requestId,
          consumingRequestId,
          scopeMode: "request_id",
          attempt,
        },
        "No matching active grant found for request ID",
      );
      return { ok: false, grant: null };
    }

    db.update(scopedApprovalGrants)
      .set({
        status: "consumed",
        consumedAt: currentTime,
        consumedByRequestId: consumingRequestId,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(scopedApprovalGrants.id, candidate.id),
          eq(scopedApprovalGrants.status, "active"),
        ),
      )
      .run();

    if (rawChanges() === 0) {
      // CAS failed — another consumer raced and won this candidate; retry with next match
      continue;
    }

    // Fetch the consumed grant to return to the caller
    const row = db
      .select()
      .from(scopedApprovalGrants)
      .where(eq(scopedApprovalGrants.id, candidate.id))
      .get();

    const grant = row ? rowToGrant(row) : null;
    log.info(
      {
        event: "scoped_grant_consume_success",
        grantId: grant?.id,
        requestId,
        consumingRequestId,
        scopeMode: "request_id",
      },
      "Scoped approval grant consumed by request ID",
    );

    return { ok: true, grant };
  }

  // All retry attempts exhausted — every candidate was stolen by concurrent consumers
  log.info(
    {
      event: "scoped_grant_consume_miss",
      requestId,
      consumingRequestId,
      scopeMode: "request_id",
      reason: "cas_exhausted",
    },
    "All CAS retry attempts exhausted for request ID consume",
  );
  return { ok: false, grant: null };
}

// ---------------------------------------------------------------------------
// Consume by tool signature (CAS: active -> consumed)
// ---------------------------------------------------------------------------

export interface ConsumeByToolSignatureParams {
  toolName: string;
  inputDigest: string;
  consumingRequestId: string;
  /** Optional context constraints — only matched when the grant has a non-null value */
  executionChannel?: string;
  conversationId?: string;
  callSessionId?: string;
  requesterExternalUserId?: string;
  now?: number;
}

export interface ConsumeByToolSignatureResult {
  ok: boolean;
  grant: ScopedApprovalGrant | null;
}

/**
 * Atomically consume a grant by tool name + input digest.
 *
 * All non-null scope fields on the grant must match the provided context.
 * This is enforced via SQL conditions that check: either the grant field is
 * NULL (wildcard), or it equals the provided value.
 *
 * If a CAS contention miss occurs (another consumer races and wins the
 * selected candidate), re-selects and retries up to {@link MAX_CAS_RETRIES}
 * times before giving up. This prevents false denials when multiple matching
 * grants exist but a concurrent consumer steals the first pick.
 */
function consumeScopedApprovalGrantByToolSignature(
  params: ConsumeByToolSignatureParams,
): ConsumeByToolSignatureResult {
  const db = getDb();
  const currentTime = params.now ?? Date.now();

  const conditions = [
    eq(scopedApprovalGrants.toolName, params.toolName),
    eq(scopedApprovalGrants.inputDigest, params.inputDigest),
    eq(scopedApprovalGrants.scopeMode, "tool_signature"),
    eq(scopedApprovalGrants.status, "active"),
    sql`${scopedApprovalGrants.expiresAt} > ${currentTime}`,
  ];

  // Context constraints: grant field must be NULL (any) or match exactly
  if (params.executionChannel !== undefined) {
    conditions.push(
      sql`(${scopedApprovalGrants.executionChannel} IS NULL OR ${scopedApprovalGrants.executionChannel} = ${params.executionChannel})`,
    );
  } else {
    // If caller provides no execution channel, only match grants with NULL (any)
    conditions.push(sql`${scopedApprovalGrants.executionChannel} IS NULL`);
  }

  if (params.conversationId !== undefined) {
    conditions.push(
      sql`(${scopedApprovalGrants.conversationId} IS NULL OR ${scopedApprovalGrants.conversationId} = ${params.conversationId})`,
    );
  } else {
    conditions.push(sql`${scopedApprovalGrants.conversationId} IS NULL`);
  }

  if (params.callSessionId !== undefined) {
    conditions.push(
      sql`(${scopedApprovalGrants.callSessionId} IS NULL OR ${scopedApprovalGrants.callSessionId} = ${params.callSessionId})`,
    );
  } else {
    conditions.push(sql`${scopedApprovalGrants.callSessionId} IS NULL`);
  }

  if (params.requesterExternalUserId !== undefined) {
    conditions.push(
      sql`(${scopedApprovalGrants.requesterExternalUserId} IS NULL OR ${scopedApprovalGrants.requesterExternalUserId} = ${params.requesterExternalUserId})`,
    );
  } else {
    conditions.push(
      sql`${scopedApprovalGrants.requesterExternalUserId} IS NULL`,
    );
  }

  const specificityOrder = sql`(CASE WHEN ${scopedApprovalGrants.executionChannel} IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN ${scopedApprovalGrants.conversationId} IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN ${scopedApprovalGrants.callSessionId} IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN ${scopedApprovalGrants.requesterExternalUserId} IS NOT NULL THEN 1 ELSE 0 END) DESC`;

  // Retry loop: if CAS fails because another consumer stole our candidate,
  // re-select and try again — another matching active grant may still exist.
  for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt++) {
    // Select a single matching grant to consume (prefer most specific: fewest NULL scope fields).
    // This avoids burning multiple grants when a wildcard grant and a specific grant both match.
    const candidate = db
      .select({ id: scopedApprovalGrants.id })
      .from(scopedApprovalGrants)
      .where(and(...conditions))
      .orderBy(specificityOrder)
      .limit(1)
      .get();

    if (!candidate) {
      log.info(
        {
          event: "scoped_grant_consume_miss",
          toolName: params.toolName,
          scopeMode: "tool_signature",
          attempt,
        },
        "No matching active grant found for tool signature",
      );
      return { ok: false, grant: null };
    }

    db.update(scopedApprovalGrants)
      .set({
        status: "consumed",
        consumedAt: currentTime,
        consumedByRequestId: params.consumingRequestId,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(scopedApprovalGrants.id, candidate.id),
          eq(scopedApprovalGrants.status, "active"),
        ),
      )
      .run();

    if (rawChanges() === 0) {
      // CAS failed — another consumer raced and won this candidate; retry with next match
      continue;
    }

    // Fetch the consumed grant
    const row = db
      .select()
      .from(scopedApprovalGrants)
      .where(eq(scopedApprovalGrants.id, candidate.id))
      .get();

    const grant = row ? rowToGrant(row) : null;
    log.info(
      {
        event: "scoped_grant_consume_success",
        grantId: grant?.id,
        toolName: params.toolName,
        consumingRequestId: params.consumingRequestId,
        scopeMode: "tool_signature",
      },
      "Scoped approval grant consumed by tool signature",
    );

    return { ok: true, grant };
  }

  // All retry attempts exhausted — every candidate was stolen by concurrent consumers
  log.info(
    {
      event: "scoped_grant_consume_miss",
      toolName: params.toolName,
      scopeMode: "tool_signature",
      reason: "cas_exhausted",
    },
    "All CAS retry attempts exhausted for tool signature consume",
  );
  return { ok: false, grant: null };
}

// ---------------------------------------------------------------------------
// Expire grants past their TTL
// ---------------------------------------------------------------------------

/**
 * Bulk-expire all active grants whose `expiresAt` is at or before `now`.
 * Returns the number of grants expired.
 */
export function expireScopedApprovalGrants(now?: number): number {
  const db = getDb();
  const currentTime = now ?? Date.now();

  db.update(scopedApprovalGrants)
    .set({
      status: "expired",
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(scopedApprovalGrants.status, "active"),
        sql`${scopedApprovalGrants.expiresAt} <= ${currentTime}`,
      ),
    )
    .run();

  const count = rawChanges();
  if (count > 0) {
    log.info(
      { event: "scoped_grant_expired", count },
      `Expired ${count} scoped approval grant(s)`,
    );
  }

  return count;
}

// ---------------------------------------------------------------------------
// Revoke active grants for a context
// ---------------------------------------------------------------------------

export interface RevokeContextParams {
  conversationId?: string;
  callSessionId?: string;
  requestChannel?: string;
}

/**
 * Revoke all active grants matching the given context filters.
 * At least one filter must be provided.  Returns the number of
 * grants revoked.
 *
 * Typical use: revoke all grants for a call session when the call ends.
 */
export function revokeScopedApprovalGrantsForContext(
  params: RevokeContextParams,
  now?: number,
): number {
  const db = getDb();
  const currentTime = now ?? Date.now();

  const conditions = [eq(scopedApprovalGrants.status, "active")];

  if (params.conversationId !== undefined) {
    conditions.push(
      eq(scopedApprovalGrants.conversationId, params.conversationId),
    );
  }
  if (params.callSessionId !== undefined) {
    conditions.push(
      eq(scopedApprovalGrants.callSessionId, params.callSessionId),
    );
  }
  if (params.requestChannel !== undefined) {
    conditions.push(
      eq(scopedApprovalGrants.requestChannel, params.requestChannel),
    );
  }

  // Guard: at least one context filter must be provided to avoid revoking ALL active grants
  if (conditions.length === 1) {
    throw new Error(
      "revokeScopedApprovalGrantsForContext requires at least one context filter",
    );
  }

  db.update(scopedApprovalGrants)
    .set({
      status: "revoked",
      updatedAt: currentTime,
    })
    .where(and(...conditions))
    .run();

  const count = rawChanges();
  if (count > 0) {
    log.info(
      {
        event: "scoped_grant_revoked",
        count,
        conversationId: params.conversationId,
        callSessionId: params.callSessionId,
        requestChannel: params.requestChannel,
      },
      `Revoked ${count} scoped approval grant(s) for context`,
    );
  }

  return count;
}

// @internal — exposed for tests and the approval-primitive wrapper only.
// Do not import these from production code outside this package; use the
// approval-primitive API instead.
export const _internal = {
  createScopedApprovalGrant,
  consumeScopedApprovalGrantByRequestId,
  consumeScopedApprovalGrantByToolSignature,
};
