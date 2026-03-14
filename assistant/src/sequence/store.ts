/**
 * SQLite-backed sequence store.
 *
 * Follows the same patterns as schedule-store.ts:
 * - Flat exported functions (no class)
 * - getDb() called inside each function
 * - Optimistic locking for claimDueEnrollments
 */

import { and, asc, eq, lte, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb, rawChanges } from "../memory/db.js";
import { sequenceEnrollments, sequences } from "../memory/schema.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import {
  cast,
  createRowMapper,
  parseJson,
  parseJsonNullable,
} from "../util/row-mapper.js";
import type {
  CreateSequenceInput,
  EnrollContactInput,
  EnrollmentExitReason,
  ListEnrollmentsFilter,
  ListSequencesFilter,
  Sequence,
  SequenceEnrollment,
  SequenceStep,
  UpdateSequenceInput,
} from "./types.js";

// ── Row Mappers ─────────────────────────────────────────────────────

const parseSequenceRow = createRowMapper<
  typeof sequences.$inferSelect,
  Sequence
>({
  id: "id",
  name: "name",
  description: "description",
  channel: "channel",
  steps: { from: "steps", transform: parseJson<SequenceStep[]>([]) },
  exitOnReply: "exitOnReply",
  status: { from: "status", transform: cast<Sequence["status"]>() },
  createdAt: "createdAt",
  updatedAt: "updatedAt",
});

const parseEnrollmentRow = createRowMapper<
  typeof sequenceEnrollments.$inferSelect,
  SequenceEnrollment
>({
  id: "id",
  sequenceId: "sequenceId",
  contactEmail: "contactEmail",
  contactName: "contactName",
  currentStep: "currentStep",
  status: { from: "status", transform: cast<SequenceEnrollment["status"]>() },
  threadId: "threadId",
  nextStepAt: "nextStepAt",
  context: {
    from: "context",
    transform: parseJsonNullable<Record<string, unknown>>(),
  },
  createdAt: "createdAt",
  updatedAt: "updatedAt",
});

// ── Sequence CRUD ───────────────────────────────────────────────────

export function createSequence(input: CreateSequenceInput): Sequence {
  const db = getDb();
  const now = Date.now();
  const row = {
    id: uuid(),
    name: input.name,
    description: input.description ?? null,
    channel: input.channel,
    steps: JSON.stringify(input.steps),
    exitOnReply: input.exitOnReply ?? true,
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(sequences).values(row).run();
  return parseSequenceRow(row);
}

export function getSequence(id: string): Sequence | undefined {
  const db = getDb();
  const row = db.select().from(sequences).where(eq(sequences.id, id)).get();
  return row ? parseSequenceRow(row) : undefined;
}

export function listSequences(filter?: ListSequencesFilter): Sequence[] {
  const db = getDb();
  const conditions = [];
  if (filter?.status) conditions.push(eq(sequences.status, filter.status));

  const rows =
    conditions.length > 0
      ? db
          .select()
          .from(sequences)
          .where(and(...conditions))
          .all()
      : db.select().from(sequences).all();
  return rows.map(parseSequenceRow);
}

export function updateSequence(
  id: string,
  patch: UpdateSequenceInput,
): Sequence | undefined {
  const db = getDb();
  const now = Date.now();
  const updates: Record<string, unknown> = { updatedAt: now };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.steps !== undefined) updates.steps = JSON.stringify(patch.steps);
  if (patch.exitOnReply !== undefined) updates.exitOnReply = patch.exitOnReply;
  if (patch.status !== undefined) updates.status = patch.status;

  db.update(sequences).set(updates).where(eq(sequences.id, id)).run();
  return getSequence(id);
}

export function deleteSequence(id: string): void {
  const db = getDb();
  // Cancel all active enrollments first (cascade handles FK, but we want explicit status update)
  db.update(sequenceEnrollments)
    .set({ status: "cancelled", updatedAt: Date.now() })
    .where(
      and(
        eq(sequenceEnrollments.sequenceId, id),
        eq(sequenceEnrollments.status, "active"),
      ),
    )
    .run();
  db.delete(sequences).where(eq(sequences.id, id)).run();
}

// ── Enrollment CRUD ─────────────────────────────────────────────────

export function enrollContact(input: EnrollContactInput): SequenceEnrollment {
  const db = getDb();
  const now = Date.now();

  // Look up the sequence to compute initial nextStepAt
  const seq = getSequence(input.sequenceId);
  if (!seq)
    throw new AssistantError(
      `Sequence not found: ${input.sequenceId}`,
      ErrorCode.INTERNAL_ERROR,
    );
  if (seq.steps.length === 0)
    throw new AssistantError("Sequence has no steps", ErrorCode.INTERNAL_ERROR);

  const firstStep = seq.steps[0];
  const nextStepAt = now + firstStep.delaySeconds * 1000;

  const row = {
    id: uuid(),
    sequenceId: input.sequenceId,
    contactEmail: input.contactEmail.toLowerCase(),
    contactName: input.contactName ?? null,
    currentStep: 0,
    status: "active" as const,
    threadId: null,
    nextStepAt,
    context: input.context ? JSON.stringify(input.context) : null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(sequenceEnrollments).values(row).run();
  return parseEnrollmentRow(row);
}

export function getEnrollment(id: string): SequenceEnrollment | undefined {
  const db = getDb();
  const row = db
    .select()
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.id, id))
    .get();
  return row ? parseEnrollmentRow(row) : undefined;
}

export function listEnrollments(
  filter?: ListEnrollmentsFilter,
): SequenceEnrollment[] {
  const db = getDb();
  const conditions = [];
  if (filter?.sequenceId)
    conditions.push(eq(sequenceEnrollments.sequenceId, filter.sequenceId));
  if (filter?.status)
    conditions.push(eq(sequenceEnrollments.status, filter.status));
  if (filter?.contactEmail)
    conditions.push(eq(sequenceEnrollments.contactEmail, filter.contactEmail));

  const rows =
    conditions.length > 0
      ? db
          .select()
          .from(sequenceEnrollments)
          .where(and(...conditions))
          .all()
      : db.select().from(sequenceEnrollments).all();
  return rows.map(parseEnrollmentRow);
}

/**
 * Atomically claim enrollments that are due for processing.
 *
 * Uses the same optimistic locking pattern as claimDueSchedules:
 * 1. Query candidates (status=active, nextStepAt <= now)
 * 2. For each, UPDATE with WHERE status='active' — only succeeds if not already claimed
 * 3. Check rawChanges() to confirm the lock was acquired
 */
export function claimDueEnrollments(
  now: number,
  limit = 10,
): SequenceEnrollment[] {
  const db = getDb();
  const candidates = db
    .select()
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.status, "active"),
        lte(sequenceEnrollments.nextStepAt, now),
      ),
    )
    .orderBy(asc(sequenceEnrollments.nextStepAt))
    .limit(limit)
    .all();

  const claimed: SequenceEnrollment[] = [];
  for (const row of candidates) {
    // Optimistic lock: set status to 'active' (no-op value-wise) but bump updatedAt
    // The WHERE ensures only one claimer succeeds
    // Optimistic lock: null out nextStepAt to prevent the row from being
    // picked up by a concurrent claim. The WHERE on the old nextStepAt value
    // ensures only one claimer wins (same pattern as reminders changing
    // status from 'pending' to 'firing').
    db.update(sequenceEnrollments)
      .set({ nextStepAt: null, updatedAt: now })
      .where(
        and(
          eq(sequenceEnrollments.id, row.id),
          eq(sequenceEnrollments.status, "active"),
          sql`${sequenceEnrollments.nextStepAt} = ${row.nextStepAt}`,
        ),
      )
      .run();

    if (rawChanges() === 0) continue;

    claimed.push(
      parseEnrollmentRow({ ...row, nextStepAt: null, updatedAt: now }),
    );
  }
  return claimed;
}

export function advanceEnrollment(
  id: string,
  threadId?: string,
  nextStepAt?: number | null,
): SequenceEnrollment | undefined {
  const db = getDb();
  const now = Date.now();
  const updates: Record<string, unknown> = {
    updatedAt: now,
    currentStep: db
      .select({ val: sequenceEnrollments.currentStep })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, id))
      .get()?.val,
  };

  // Load current to increment step
  const current = getEnrollment(id);
  if (!current) return undefined;

  updates.currentStep = current.currentStep + 1;
  if (threadId !== undefined) updates.threadId = threadId;
  if (nextStepAt !== undefined) updates.nextStepAt = nextStepAt;

  db.update(sequenceEnrollments)
    .set(updates)
    .where(eq(sequenceEnrollments.id, id))
    .run();

  return getEnrollment(id);
}

export function exitEnrollment(id: string, reason: EnrollmentExitReason): void {
  const db = getDb();
  db.update(sequenceEnrollments)
    .set({ status: reason, nextStepAt: null, updatedAt: Date.now() })
    .where(eq(sequenceEnrollments.id, id))
    .run();
}

/** Pause an active enrollment — preserves current step so it can be resumed later. */
export function pauseEnrollment(id: string): void {
  const db = getDb();
  db.update(sequenceEnrollments)
    .set({ status: "paused", nextStepAt: null, updatedAt: Date.now() })
    .where(eq(sequenceEnrollments.id, id))
    .run();
}

/** Resume a paused enrollment — re-activates it so the scheduler picks it up. */
export function resumeEnrollment(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.update(sequenceEnrollments)
    .set({ status: "active", nextStepAt: now, updatedAt: now })
    .where(eq(sequenceEnrollments.id, id))
    .run();
}

// ── Query Helpers ───────────────────────────────────────────────────

export function findActiveEnrollmentsByEmail(
  email: string,
): SequenceEnrollment[] {
  const db = getDb();
  const rows = db
    .select()
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.contactEmail, email),
        eq(sequenceEnrollments.status, "active"),
      ),
    )
    .all();
  return rows.map(parseEnrollmentRow);
}

export function countActiveEnrollments(sequenceId: string): number {
  const db = getDb();
  const rows = db
    .select()
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.sequenceId, sequenceId),
        eq(sequenceEnrollments.status, "active"),
      ),
    )
    .all();
  return rows.length;
}

/** Re-set nextStepAt without advancing the step counter (e.g., when re-scheduling after a pause). */
export function rescheduleEnrollment(id: string, nextStepAt: number): void {
  const db = getDb();
  db.update(sequenceEnrollments)
    .set({ nextStepAt, updatedAt: Date.now() })
    .where(eq(sequenceEnrollments.id, id))
    .run();
}

/** Persist a thread ID on an enrollment without advancing the step counter. */
export function updateEnrollmentThreadId(id: string, threadId: string): void {
  const db = getDb();
  db.update(sequenceEnrollments)
    .set({ threadId, updatedAt: Date.now() })
    .where(eq(sequenceEnrollments.id, id))
    .run();
}
