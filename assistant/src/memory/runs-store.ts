/**
 * CRUD store for message runs (approval flow state).
 *
 * Runs track the lifecycle of an agent loop triggered by a user message:
 *   running → needs_confirmation → running → completed | failed
 */

import { eq, inArray } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { messageRuns } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunStatus = 'running' | 'needs_confirmation' | 'completed' | 'failed';

export interface PendingConfirmation {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  riskLevel: string;
  executionTarget?: 'sandbox' | 'host';
  allowlistOptions?: Array<{ label: string; pattern: string }>;
  scopeOptions?: Array<{ label: string; scope: string }>;
  /** Principal kind that initiated this tool use (e.g. 'core' or 'skill'). */
  principalKind?: string;
  /** Skill ID when principalKind is 'skill'. */
  principalId?: string;
  /** Content-hash of the skill source for version tracking. */
  principalVersion?: string;
  /** When false, the client should hide "always allow" / trust-rule persistence affordances. */
  persistentDecisionsAllowed?: boolean;
}

export interface Run {
  id: string;
  conversationId: string;
  messageId: string | null;
  status: RunStatus;
  pendingConfirmation: PendingConfirmation | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToRun(row: typeof messageRuns.$inferSelect): Run {
  let pendingConfirmation: PendingConfirmation | null = null;
  if (row.pendingConfirmation) {
    try { pendingConfirmation = JSON.parse(row.pendingConfirmation); } catch { /* malformed */ }
  }
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    status: row.status as RunStatus,
    pendingConfirmation,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    estimatedCost: row.estimatedCost,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function createRun(
  conversationId: string,
  messageId?: string,
): Run {
  const db = getDb();
  const now = Date.now();
  const id = uuid();

  const row = {
    id,
    conversationId,
    messageId: messageId ?? null,
    status: 'running' as const,
    pendingConfirmation: null,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(messageRuns).values(row).run();

  return rowToRun(row);
}

export function getRun(runId: string): Run | null {
  const db = getDb();
  const row = db.select().from(messageRuns).where(eq(messageRuns.id, runId)).get();
  return row ? rowToRun(row) : null;
}

export function setRunConfirmation(
  runId: string,
  confirmation: PendingConfirmation,
): void {
  const db = getDb();
  const now = Date.now();
  db.update(messageRuns)
    .set({
      status: 'needs_confirmation',
      pendingConfirmation: JSON.stringify(confirmation),
      updatedAt: now,
    })
    .where(eq(messageRuns.id, runId))
    .run();
}

export function clearRunConfirmation(runId: string): void {
  const db = getDb();
  const now = Date.now();
  db.update(messageRuns)
    .set({
      status: 'running',
      pendingConfirmation: null,
      updatedAt: now,
    })
    .where(eq(messageRuns.id, runId))
    .run();
}

export function completeRun(runId: string, usage?: RunUsage): void {
  const db = getDb();
  const now = Date.now();
  db.update(messageRuns)
    .set({
      status: 'completed',
      pendingConfirmation: null,
      ...(usage?.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
      ...(usage?.estimatedCost != null ? { estimatedCost: usage.estimatedCost } : {}),
      updatedAt: now,
    })
    .where(eq(messageRuns.id, runId))
    .run();
}

export function failRun(runId: string, error: string): void {
  const db = getDb();
  const now = Date.now();
  db.update(messageRuns)
    .set({
      status: 'failed',
      pendingConfirmation: null,
      error,
      updatedAt: now,
    })
    .where(eq(messageRuns.id, runId))
    .run();
}

/**
 * Mark all non-terminal runs as failed.
 * Called on startup to recover from daemon restarts that left runs
 * in running/needs_confirmation with no in-memory state to resolve them.
 * Returns the number of rows affected.
 */
export function failOrphanedRuns(): number {
  const db = getDb();
  const now = Date.now();
  const activeStatuses = ['running', 'needs_confirmation'];

  // Count first so we can report how many were recovered.
  const active = db.select({ id: messageRuns.id })
    .from(messageRuns)
    .where(inArray(messageRuns.status, activeStatuses))
    .all();

  if (active.length === 0) return 0;

  db.update(messageRuns)
    .set({
      status: 'failed',
      pendingConfirmation: null,
      error: 'Run was interrupted (daemon restart)',
      updatedAt: now,
    })
    .where(inArray(messageRuns.status, activeStatuses))
    .run();

  return active.length;
}
