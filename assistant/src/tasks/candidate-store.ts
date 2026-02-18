import { eq, desc, isNull } from 'drizzle-orm';
import { getDb } from '../memory/db.js';
import { taskCandidates } from '../memory/schema.js';

// ── Types ────────────────────────────────────────────────────────────

export interface TaskCandidate {
  id: string;
  sourceConversationId: string;
  compiledTemplate: string;
  confidence: number | null;
  requiredTools: string[] | null;
  createdAt: number;
  promotedTaskId: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Convert a raw DB row to a TaskCandidate, deserializing the JSON requiredTools field. */
function rowToCandidate(row: typeof taskCandidates.$inferSelect): TaskCandidate {
  return {
    id: row.id,
    sourceConversationId: row.sourceConversationId,
    compiledTemplate: row.compiledTemplate,
    confidence: row.confidence,
    requiredTools: row.requiredTools ? JSON.parse(row.requiredTools) : null,
    createdAt: row.createdAt,
    promotedTaskId: row.promotedTaskId,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────

/** Record a new task candidate from a conversation. */
export function createCandidate(opts: {
  sourceConversationId: string;
  compiledTemplate: string;
  confidence?: number;
  requiredTools?: string[];
}): TaskCandidate {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  const row = {
    id,
    sourceConversationId: opts.sourceConversationId,
    compiledTemplate: opts.compiledTemplate,
    confidence: opts.confidence ?? null,
    requiredTools: opts.requiredTools ? JSON.stringify(opts.requiredTools) : null,
    createdAt: now,
    promotedTaskId: null,
  };
  db.insert(taskCandidates).values(row).run();
  return {
    ...row,
    requiredTools: opts.requiredTools ?? null,
  };
}

/** List unpromoted candidates (most recent first). */
export function listUnpromotedCandidates(limit?: number): TaskCandidate[] {
  const db = getDb();
  const query = db
    .select()
    .from(taskCandidates)
    .where(isNull(taskCandidates.promotedTaskId))
    .orderBy(desc(taskCandidates.createdAt));
  const rows = limit ? query.limit(limit).all() : query.all();
  return rows.map(rowToCandidate);
}

/** Mark a candidate as promoted to a real task. */
export function promoteCandidate(candidateId: string, taskId: string): void {
  const db = getDb();
  db.update(taskCandidates)
    .set({ promotedTaskId: taskId })
    .where(eq(taskCandidates.id, candidateId))
    .run();
}

/** Get a candidate by ID. */
export function getCandidate(id: string): TaskCandidate | undefined {
  const db = getDb();
  const row = db.select().from(taskCandidates).where(eq(taskCandidates.id, id)).get();
  return row ? rowToCandidate(row) : undefined;
}
