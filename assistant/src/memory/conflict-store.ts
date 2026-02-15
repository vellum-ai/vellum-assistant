import { and, asc, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { memoryItemConflicts } from './schema.js';

export type MemoryConflictRelationship =
  | 'contradiction'
  | 'ambiguous_contradiction'
  | 'update'
  | 'complement';

export type MemoryConflictStatus =
  | 'pending_clarification'
  | 'resolved_keep_existing'
  | 'resolved_keep_candidate'
  | 'resolved_merge'
  | 'dismissed';

export type ResolvedMemoryConflictStatus = Exclude<MemoryConflictStatus, 'pending_clarification'>;

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
  scopeId?: string;
  existingItemId: string;
  candidateItemId: string;
  relationship: string;
  clarificationQuestion?: string | null;
}

export interface ResolveConflictInput {
  status: ResolvedMemoryConflictStatus;
  resolutionNote?: string | null;
}

export function createOrUpdatePendingConflict(input: CreatePendingConflictInput): MemoryItemConflict {
  const db = getDb();
  const now = Date.now();
  const scopeId = input.scopeId ?? 'default';
  const existing = getPendingConflictByPair(scopeId, input.existingItemId, input.candidateItemId);

  if (existing) {
    db.update(memoryItemConflicts)
      .set({
        relationship: input.relationship,
        clarificationQuestion: input.clarificationQuestion ?? existing.clarificationQuestion,
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
  db.insert(memoryItemConflicts).values({
    id,
    scopeId,
    existingItemId: input.existingItemId,
    candidateItemId: input.candidateItemId,
    relationship: input.relationship,
    status: 'pending_clarification',
    clarificationQuestion: input.clarificationQuestion ?? null,
    resolutionNote: null,
    lastAskedAt: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
  }).run();

  const created = getConflictById(id);
  if (!created) {
    throw new Error(`Failed to load created conflict: ${id}`);
  }
  return created;
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
    .where(and(
      eq(memoryItemConflicts.scopeId, scopeId),
      eq(memoryItemConflicts.existingItemId, existingItemId),
      eq(memoryItemConflicts.candidateItemId, candidateItemId),
      eq(memoryItemConflicts.status, 'pending_clarification'),
    ))
    .get();
  return row ? toConflict(row) : null;
}

export function listPendingConflicts(scopeId: string, limit = 100): MemoryItemConflict[] {
  if (limit <= 0) return [];
  const db = getDb();
  const rows = db
    .select()
    .from(memoryItemConflicts)
    .where(and(
      eq(memoryItemConflicts.scopeId, scopeId),
      eq(memoryItemConflicts.status, 'pending_clarification'),
    ))
    .orderBy(asc(memoryItemConflicts.createdAt))
    .limit(limit)
    .all();
  return rows.map(toConflict);
}

export function markConflictAsked(conflictId: string, askedAt = Date.now()): boolean {
  const db = getDb();
  const result = db.update(memoryItemConflicts)
    .set({
      lastAskedAt: askedAt,
      updatedAt: askedAt,
    })
    .where(eq(memoryItemConflicts.id, conflictId))
    .run() as unknown as { changes?: number };

  return (result.changes ?? 0) > 0;
}

export function resolveConflict(conflictId: string, input: ResolveConflictInput): MemoryItemConflict | null {
  const existing = getConflictById(conflictId);
  if (!existing) return null;

  const db = getDb();
  const now = Date.now();
  db.update(memoryItemConflicts)
    .set({
      status: input.status,
      resolutionNote: input.resolutionNote ?? existing.resolutionNote,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(eq(memoryItemConflicts.id, conflictId))
    .run();

  return getConflictById(conflictId);
}

function toConflict(row: typeof memoryItemConflicts.$inferSelect): MemoryItemConflict {
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
