/**
 * CRUD operations for notification decisions.
 *
 * Each row records the routing decision made by the decision engine for
 * a given notification event: whether to notify, which channels, and the
 * reasoning behind it. This provides a full audit trail of how signals
 * were routed.
 */

import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../memory/db.js';
import { notificationDecisions, notificationEvents } from '../memory/schema.js';

export interface NotificationDecisionRow {
  id: string;
  notificationEventId: string;
  shouldNotify: boolean;
  selectedChannels: string; // JSON array
  reasoningSummary: string;
  confidence: number;
  fallbackUsed: boolean;
  promptVersion: string | null;
  validationResults: string | null; // JSON
  createdAt: number;
}

function rowToDecision(row: typeof notificationDecisions.$inferSelect): NotificationDecisionRow {
  return {
    id: row.id,
    notificationEventId: row.notificationEventId,
    shouldNotify: row.shouldNotify === 1,
    selectedChannels: row.selectedChannels,
    reasoningSummary: row.reasoningSummary,
    confidence: row.confidence,
    fallbackUsed: row.fallbackUsed === 1,
    promptVersion: row.promptVersion,
    validationResults: row.validationResults,
    createdAt: row.createdAt,
  };
}

export interface CreateDecisionParams {
  id: string;
  notificationEventId: string;
  shouldNotify: boolean;
  selectedChannels: string[]; // will be serialised to JSON
  reasoningSummary: string;
  confidence: number;
  fallbackUsed: boolean;
  promptVersion?: string;
  validationResults?: Record<string, unknown>;
}

/** Insert a new decision record. */
export function createDecision(params: CreateDecisionParams): NotificationDecisionRow {
  const db = getDb();
  const now = Date.now();

  const row = {
    id: params.id,
    notificationEventId: params.notificationEventId,
    shouldNotify: params.shouldNotify ? 1 : 0,
    selectedChannels: JSON.stringify(params.selectedChannels),
    reasoningSummary: params.reasoningSummary,
    confidence: params.confidence,
    fallbackUsed: params.fallbackUsed ? 1 : 0,
    promptVersion: params.promptVersion ?? null,
    validationResults: params.validationResults ? JSON.stringify(params.validationResults) : null,
    createdAt: now,
  };

  db.insert(notificationDecisions).values(row).run();

  return {
    ...row,
    shouldNotify: params.shouldNotify,
    fallbackUsed: params.fallbackUsed,
  };
}

/** Fetch a single decision by ID. */
export function getDecisionById(id: string): NotificationDecisionRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(notificationDecisions)
    .where(eq(notificationDecisions.id, id))
    .get();
  if (!row) return null;
  return rowToDecision(row);
}

/** Fetch a decision by its parent event ID. */
export function getDecisionByEventId(eventId: string): NotificationDecisionRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(notificationDecisions)
    .where(eq(notificationDecisions.notificationEventId, eventId))
    .get();
  if (!row) return null;
  return rowToDecision(row);
}

export interface ListDecisionsFilters {
  shouldNotify?: boolean;
  limit?: number;
}

/** List decisions for an assistant with optional filters. */
export function listDecisions(
  assistantId: string,
  filters?: ListDecisionsFilters,
): NotificationDecisionRow[] {
  const db = getDb();

  // Join through notificationEvents to filter by assistantId
  const conditions = [eq(notificationEvents.assistantId, assistantId)];

  if (filters?.shouldNotify !== undefined) {
    conditions.push(eq(notificationDecisions.shouldNotify, filters.shouldNotify ? 1 : 0));
  }

  const limit = filters?.limit ?? 50;

  const rows = db
    .select({
      id: notificationDecisions.id,
      notificationEventId: notificationDecisions.notificationEventId,
      shouldNotify: notificationDecisions.shouldNotify,
      selectedChannels: notificationDecisions.selectedChannels,
      reasoningSummary: notificationDecisions.reasoningSummary,
      confidence: notificationDecisions.confidence,
      fallbackUsed: notificationDecisions.fallbackUsed,
      promptVersion: notificationDecisions.promptVersion,
      validationResults: notificationDecisions.validationResults,
      createdAt: notificationDecisions.createdAt,
    })
    .from(notificationDecisions)
    .innerJoin(notificationEvents, eq(notificationDecisions.notificationEventId, notificationEvents.id))
    .where(and(...conditions))
    .orderBy(desc(notificationDecisions.createdAt))
    .limit(limit)
    .all();

  return rows.map((row) => ({
    id: row.id,
    notificationEventId: row.notificationEventId,
    shouldNotify: row.shouldNotify === 1,
    selectedChannels: row.selectedChannels,
    reasoningSummary: row.reasoningSummary,
    confidence: row.confidence,
    fallbackUsed: row.fallbackUsed === 1,
    promptVersion: row.promptVersion,
    validationResults: row.validationResults,
    createdAt: row.createdAt,
  }));
}
