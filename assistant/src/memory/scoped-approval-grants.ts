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

import { and, eq, lt, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

import { getDb, rawChanges } from './db.js';
import { scopedApprovalGrants } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScopeMode = 'request_id' | 'tool_signature';
export type GrantStatus = 'active' | 'consumed' | 'expired' | 'revoked';

export interface ScopedApprovalGrant {
  id: string;
  assistantId: string;
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
  expiresAt: string;
  consumedAt: string | null;
  consumedByRequestId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToGrant(row: typeof scopedApprovalGrants.$inferSelect): ScopedApprovalGrant {
  return {
    id: row.id,
    assistantId: row.assistantId,
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
  assistantId: string;
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
  expiresAt: string;
}

export function createScopedApprovalGrant(params: CreateScopedApprovalGrantParams): ScopedApprovalGrant {
  const db = getDb();
  const now = new Date().toISOString();
  const id = uuid();

  const row = {
    id,
    assistantId: params.assistantId,
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
    status: 'active' as const,
    expiresAt: params.expiresAt,
    consumedAt: null,
    consumedByRequestId: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(scopedApprovalGrants).values(row).run();
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
export function consumeScopedApprovalGrantByRequestId(
  requestId: string,
  consumingRequestId: string,
  now?: string,
): ConsumeByRequestIdResult {
  const db = getDb();
  const currentTime = now ?? new Date().toISOString();

  db.update(scopedApprovalGrants)
    .set({
      status: 'consumed',
      consumedAt: currentTime,
      consumedByRequestId: consumingRequestId,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(scopedApprovalGrants.requestId, requestId),
        eq(scopedApprovalGrants.scopeMode, 'request_id'),
        eq(scopedApprovalGrants.status, 'active'),
        sql`${scopedApprovalGrants.expiresAt} > ${currentTime}`,
      ),
    )
    .run();

  if (rawChanges() === 0) {
    return { ok: false, grant: null };
  }

  // Fetch the consumed grant to return to the caller
  const row = db
    .select()
    .from(scopedApprovalGrants)
    .where(
      and(
        eq(scopedApprovalGrants.requestId, requestId),
        eq(scopedApprovalGrants.status, 'consumed'),
        eq(scopedApprovalGrants.consumedByRequestId, consumingRequestId),
      ),
    )
    .get();

  return { ok: true, grant: row ? rowToGrant(row) : null };
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
  now?: string;
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
 */
export function consumeScopedApprovalGrantByToolSignature(
  params: ConsumeByToolSignatureParams,
): ConsumeByToolSignatureResult {
  const db = getDb();
  const currentTime = params.now ?? new Date().toISOString();

  const conditions = [
    eq(scopedApprovalGrants.toolName, params.toolName),
    eq(scopedApprovalGrants.inputDigest, params.inputDigest),
    eq(scopedApprovalGrants.scopeMode, 'tool_signature'),
    eq(scopedApprovalGrants.status, 'active'),
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
    conditions.push(sql`${scopedApprovalGrants.requesterExternalUserId} IS NULL`);
  }

  db.update(scopedApprovalGrants)
    .set({
      status: 'consumed',
      consumedAt: currentTime,
      consumedByRequestId: params.consumingRequestId,
      updatedAt: currentTime,
    })
    .where(and(...conditions))
    .run();

  if (rawChanges() === 0) {
    return { ok: false, grant: null };
  }

  // Fetch the consumed grant
  const row = db
    .select()
    .from(scopedApprovalGrants)
    .where(
      and(
        eq(scopedApprovalGrants.toolName, params.toolName),
        eq(scopedApprovalGrants.inputDigest, params.inputDigest),
        eq(scopedApprovalGrants.status, 'consumed'),
        eq(scopedApprovalGrants.consumedByRequestId, params.consumingRequestId),
      ),
    )
    .get();

  return { ok: true, grant: row ? rowToGrant(row) : null };
}

// ---------------------------------------------------------------------------
// Expire grants past their TTL
// ---------------------------------------------------------------------------

/**
 * Bulk-expire all active grants whose `expiresAt` is at or before `now`.
 * Returns the number of grants expired.
 */
export function expireScopedApprovalGrants(now?: string): number {
  const db = getDb();
  const currentTime = now ?? new Date().toISOString();

  db.update(scopedApprovalGrants)
    .set({
      status: 'expired',
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(scopedApprovalGrants.status, 'active'),
        sql`${scopedApprovalGrants.expiresAt} <= ${currentTime}`,
      ),
    )
    .run();

  return rawChanges();
}

// ---------------------------------------------------------------------------
// Revoke active grants for a context
// ---------------------------------------------------------------------------

export interface RevokeContextParams {
  assistantId?: string;
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
export function revokeScopedApprovalGrantsForContext(params: RevokeContextParams, now?: string): number {
  const db = getDb();
  const currentTime = now ?? new Date().toISOString();

  const conditions = [eq(scopedApprovalGrants.status, 'active')];

  if (params.assistantId !== undefined) {
    conditions.push(eq(scopedApprovalGrants.assistantId, params.assistantId));
  }
  if (params.conversationId !== undefined) {
    conditions.push(eq(scopedApprovalGrants.conversationId, params.conversationId));
  }
  if (params.callSessionId !== undefined) {
    conditions.push(eq(scopedApprovalGrants.callSessionId, params.callSessionId));
  }
  if (params.requestChannel !== undefined) {
    conditions.push(eq(scopedApprovalGrants.requestChannel, params.requestChannel));
  }

  db.update(scopedApprovalGrants)
    .set({
      status: 'revoked',
      updatedAt: currentTime,
    })
    .where(and(...conditions))
    .run();

  return rawChanges();
}
