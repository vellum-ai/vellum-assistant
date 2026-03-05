import { and, asc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb, getSqlite, rawAll } from "./db.js";
import { enqueueMemoryJob } from "./jobs-store.js";
import { memoryItemConflicts, memoryItems } from "./schema.js";
import { clampUnitInterval } from "./validation.js";

export type MemoryConflictRelationship =
  | "contradiction"
  | "ambiguous_contradiction"
  | "update"
  | "complement";

export type MemoryConflictStatus =
  | "pending_clarification"
  | "resolved_keep_existing"
  | "resolved_keep_candidate"
  | "resolved_merge"
  | "dismissed";

export type ResolvedMemoryConflictStatus = Exclude<
  MemoryConflictStatus,
  "pending_clarification"
>;

export interface MemoryItemConflict {
  id: string;
  scopeId: string;
  existingItemId: string;
  candidateItemId: string;
  relationship: string;
  status: MemoryConflictStatus;
  clarificationQuestion: string | null;
  resolutionNote: string | null;
  lastAskedAt: number | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreatePendingConflictInput {
  scopeId: string;
  existingItemId: string;
  candidateItemId: string;
  relationship: string;
  clarificationQuestion?: string | null;
}

export interface ResolveConflictInput {
  status: ResolvedMemoryConflictStatus;
  resolutionNote?: string | null;
}

export interface PendingConflictDetail extends MemoryItemConflict {
  existingStatement: string;
  candidateStatement: string;
  existingKind: string;
  candidateKind: string;
  existingVerificationState: string;
  candidateVerificationState: string;
}

export type ConflictResolutionAction =
  | "keep_existing"
  | "keep_candidate"
  | "merge";

export interface ApplyConflictResolutionInput {
  conflictId: string;
  resolution: ConflictResolutionAction;
  mergedStatement?: string | null;
  resolutionNote?: string | null;
}

export function createOrUpdatePendingConflict(
  input: CreatePendingConflictInput,
): MemoryItemConflict {
  // Wrap in BEGIN IMMEDIATE so the SELECT-then-INSERT is atomic against concurrent
  // writers. Without this, two parallel memory workers could both observe no
  // existing conflict and both attempt to INSERT the same pair, resulting in a
  // duplicate or an unexpected constraint violation.
  return getSqlite()
    .transaction((): MemoryItemConflict => {
      const db = getDb();
      const now = Date.now();
      const scopeId = input.scopeId;
      const existing = getPendingConflictByPair(
        scopeId,
        input.existingItemId,
        input.candidateItemId,
      );

      if (existing) {
        db.update(memoryItemConflicts)
          .set({
            relationship: input.relationship,
            clarificationQuestion:
              input.clarificationQuestion !== undefined
                ? input.clarificationQuestion
                : existing.clarificationQuestion,
            updatedAt: now,
          })
          .where(eq(memoryItemConflicts.id, existing.id))
          .run();
        const updated = getConflictById(existing.id);
        if (!updated) {
          throw new Error(`Failed to reload updated conflict: ${existing.id}`);
        }
        return updated;
      }

      const id = uuid();
      db.insert(memoryItemConflicts)
        .values({
          id,
          scopeId,
          existingItemId: input.existingItemId,
          candidateItemId: input.candidateItemId,
          relationship: input.relationship,
          status: "pending_clarification",
          clarificationQuestion: input.clarificationQuestion ?? null,
          resolutionNote: null,
          lastAskedAt: null,
          resolvedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const created = getConflictById(id);
      if (!created) {
        throw new Error(`Failed to load created conflict: ${id}`);
      }
      return created;
    })
    .immediate();
}

export function getConflictById(conflictId: string): MemoryItemConflict | null {
  const db = getDb();
  const row = db
    .select()
    .from(memoryItemConflicts)
    .where(eq(memoryItemConflicts.id, conflictId))
    .get();
  return row ? toConflict(row) : null;
}

export function getPendingConflictByPair(
  scopeId: string,
  existingItemId: string,
  candidateItemId: string,
): MemoryItemConflict | null {
  const db = getDb();
  const row = db
    .select()
    .from(memoryItemConflicts)
    .where(
      and(
        eq(memoryItemConflicts.scopeId, scopeId),
        eq(memoryItemConflicts.existingItemId, existingItemId),
        eq(memoryItemConflicts.candidateItemId, candidateItemId),
        eq(memoryItemConflicts.status, "pending_clarification"),
      ),
    )
    .get();
  return row ? toConflict(row) : null;
}

export function listPendingConflicts(
  scopeId: string,
  limit = 100,
): MemoryItemConflict[] {
  if (limit <= 0) return [];
  const db = getDb();
  const rows = db
    .select()
    .from(memoryItemConflicts)
    .where(
      and(
        eq(memoryItemConflicts.scopeId, scopeId),
        eq(memoryItemConflicts.status, "pending_clarification"),
      ),
    )
    .orderBy(asc(memoryItemConflicts.createdAt))
    .limit(limit)
    .all();
  return rows.map(toConflict);
}

export function listPendingConflictDetails(
  scopeId: string,
  limit = 100,
  cursor?: { createdAt: number; id: string },
): PendingConflictDetail[] {
  if (limit <= 0) return [];
  interface ConflictDetailRow {
    id: string;
    scope_id: string;
    existing_item_id: string;
    candidate_item_id: string;
    relationship: string;
    status: MemoryConflictStatus;
    clarification_question: string | null;
    resolution_note: string | null;
    last_asked_at: number | null;
    resolved_at: number | null;
    created_at: number;
    updated_at: number;
    existing_statement: string;
    candidate_statement: string;
    existing_kind: string;
    candidate_kind: string;
    existing_verification_state: string;
    candidate_verification_state: string;
  }
  const cursorClause = cursor
    ? `AND (c.created_at > ? OR (c.created_at = ? AND c.id > ?))`
    : "";
  const params: (string | number)[] = cursor
    ? [scopeId, cursor.createdAt, cursor.createdAt, cursor.id, limit]
    : [scopeId, limit];
  const rows = rawAll<ConflictDetailRow>(
    `
    SELECT
      c.id,
      c.scope_id,
      c.existing_item_id,
      c.candidate_item_id,
      c.relationship,
      c.status,
      c.clarification_question,
      c.resolution_note,
      c.last_asked_at,
      c.resolved_at,
      c.created_at,
      c.updated_at,
      existing_item.statement AS existing_statement,
      candidate_item.statement AS candidate_statement,
      existing_item.kind AS existing_kind,
      candidate_item.kind AS candidate_kind,
      existing_item.verification_state AS existing_verification_state,
      candidate_item.verification_state AS candidate_verification_state
    FROM memory_item_conflicts c
    INNER JOIN memory_items existing_item ON existing_item.id = c.existing_item_id
    INNER JOIN memory_items candidate_item ON candidate_item.id = c.candidate_item_id
    WHERE c.scope_id = ?
      AND c.status = 'pending_clarification'
      ${cursorClause}
    ORDER BY c.created_at ASC, c.id ASC
    LIMIT ?
  `,
    ...params,
  );

  return rows.map((row) => ({
    id: row.id,
    scopeId: row.scope_id,
    existingItemId: row.existing_item_id,
    candidateItemId: row.candidate_item_id,
    relationship: row.relationship,
    status: row.status,
    clarificationQuestion: row.clarification_question,
    resolutionNote: row.resolution_note,
    lastAskedAt: row.last_asked_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    existingStatement: row.existing_statement,
    candidateStatement: row.candidate_statement,
    existingKind: row.existing_kind,
    candidateKind: row.candidate_kind,
    existingVerificationState: row.existing_verification_state,
    candidateVerificationState: row.candidate_verification_state,
  }));
}

export function resolveConflict(
  conflictId: string,
  input: ResolveConflictInput,
): MemoryItemConflict | null {
  const existing = getConflictById(conflictId);
  if (!existing) return null;

  const db = getDb();
  const now = Date.now();
  db.update(memoryItemConflicts)
    .set({
      status: input.status,
      resolutionNote:
        input.resolutionNote !== undefined
          ? input.resolutionNote
          : existing.resolutionNote,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(eq(memoryItemConflicts.id, conflictId))
    .run();

  return getConflictById(conflictId);
}

export function applyConflictResolution(
  input: ApplyConflictResolutionInput,
): boolean {
  const conflict = getConflictById(input.conflictId);
  if (!conflict || conflict.status !== "pending_clarification") return false;

  const db = getDb();
  const now = Date.now();
  const existingItem = db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.id, conflict.existingItemId))
    .get();
  const candidateItem = db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.id, conflict.candidateItemId))
    .get();

  if (!existingItem || !candidateItem) {
    resolveConflict(conflict.id, {
      status: "dismissed",
      resolutionNote:
        input.resolutionNote ?? "Conflict items missing at resolution time.",
    });
    return false;
  }

  switch (input.resolution) {
    case "keep_existing": {
      db.update(memoryItems)
        .set({ status: "superseded", invalidAt: now })
        .where(eq(memoryItems.id, candidateItem.id))
        .run();
      resolveConflict(conflict.id, {
        status: "resolved_keep_existing",
        resolutionNote: input.resolutionNote ?? null,
      });
      return true;
    }
    case "keep_candidate": {
      db.update(memoryItems)
        .set({ status: "superseded", invalidAt: now })
        .where(eq(memoryItems.id, existingItem.id))
        .run();
      db.update(memoryItems)
        .set({ status: "active", validFrom: now })
        .where(eq(memoryItems.id, candidateItem.id))
        .run();
      resolveConflict(conflict.id, {
        status: "resolved_keep_candidate",
        resolutionNote: input.resolutionNote ?? null,
      });
      return true;
    }
    case "merge": {
      const mergedStatement = (input.mergedStatement ?? "").trim();
      const nextStatement =
        mergedStatement.length > 0 ? mergedStatement : candidateItem.statement;
      db.update(memoryItems)
        .set({
          statement: nextStatement,
          status: "active",
          invalidAt: null,
          lastSeenAt: Math.max(
            existingItem.lastSeenAt,
            candidateItem.lastSeenAt,
            now,
          ),
          confidence: clampUnitInterval(
            Math.max(existingItem.confidence, candidateItem.confidence),
          ),
        })
        .where(eq(memoryItems.id, existingItem.id))
        .run();
      db.update(memoryItems)
        .set({ status: "superseded", invalidAt: now })
        .where(eq(memoryItems.id, candidateItem.id))
        .run();
      enqueueMemoryJob("embed_item", { itemId: existingItem.id });
      resolveConflict(conflict.id, {
        status: "resolved_merge",
        resolutionNote: input.resolutionNote ?? null,
      });
      return true;
    }
  }
}

function toConflict(
  row: typeof memoryItemConflicts.$inferSelect,
): MemoryItemConflict {
  return {
    id: row.id,
    scopeId: row.scopeId,
    existingItemId: row.existingItemId,
    candidateItemId: row.candidateItemId,
    relationship: row.relationship,
    status: row.status as MemoryConflictStatus,
    clarificationQuestion: row.clarificationQuestion,
    resolutionNote: row.resolutionNote,
    lastAskedAt: row.lastAskedAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
