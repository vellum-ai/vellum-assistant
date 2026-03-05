/**
 * CRUD operations for notification decisions.
 *
 * Each row records the routing decision made by the decision engine for
 * a given notification event: whether to notify, which channels, and the
 * reasoning behind it. This provides a full audit trail of how signals
 * were routed.
 */

import { eq } from "drizzle-orm";

import { getDb } from "../memory/db.js";
import { notificationDecisions } from "../memory/schema.js";

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
export function createDecision(
  params: CreateDecisionParams,
): NotificationDecisionRow {
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
    validationResults: params.validationResults
      ? JSON.stringify(params.validationResults)
      : null,
    createdAt: now,
  };

  db.insert(notificationDecisions).values(row).run();

  return {
    ...row,
    shouldNotify: params.shouldNotify,
    fallbackUsed: params.fallbackUsed,
  };
}

export interface UpdateDecisionParams {
  selectedChannels?: string[];
  reasoningSummary?: string;
  validationResults?: Record<string, unknown>;
}

/** Update an existing decision row (e.g. after routing intent enforcement). */
export function updateDecision(id: string, params: UpdateDecisionParams): void {
  const db = getDb();
  const updates: Record<string, unknown> = {};
  if (params.selectedChannels !== undefined) {
    updates.selectedChannels = JSON.stringify(params.selectedChannels);
  }
  if (params.reasoningSummary !== undefined) {
    updates.reasoningSummary = params.reasoningSummary;
  }
  if (params.validationResults !== undefined) {
    updates.validationResults = JSON.stringify(params.validationResults);
  }
  if (Object.keys(updates).length === 0) return;

  db.update(notificationDecisions)
    .set(updates)
    .where(eq(notificationDecisions.id, id))
    .run();
}
