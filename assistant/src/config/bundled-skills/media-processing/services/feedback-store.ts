/**
 * Feedback store service for media event corrections.
 *
 * Provides CRUD operations for the media_event_feedback table.
 * All interfaces are generic — works for any event type, not just turnovers.
 */

import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from '../../../../memory/db.js';
import { mediaEventFeedback } from '../../../../memory/schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeedbackType = 'correct' | 'incorrect' | 'boundary_edit' | 'missed';

export interface EventFeedback {
  id: string;
  assetId: string;
  eventId: string;
  feedbackType: FeedbackType;
  originalStartTime: number | null;
  originalEndTime: number | null;
  correctedStartTime: number | null;
  correctedEndTime: number | null;
  notes: string | null;
  createdAt: number;
}

export interface SubmitFeedbackParams {
  assetId: string;
  eventId: string;
  feedbackType: FeedbackType;
  originalStartTime?: number;
  originalEndTime?: number;
  correctedStartTime?: number;
  correctedEndTime?: number;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_FEEDBACK_TYPES: FeedbackType[] = ['correct', 'incorrect', 'boundary_edit', 'missed'];

function isValidFeedbackType(type: string): type is FeedbackType {
  return VALID_FEEDBACK_TYPES.includes(type as FeedbackType);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function submitFeedback(params: SubmitFeedbackParams): EventFeedback {
  if (!isValidFeedbackType(params.feedbackType)) {
    throw new Error(`Invalid feedback type "${params.feedbackType}". Must be one of: ${VALID_FEEDBACK_TYPES.join(', ')}`);
  }

  const db = getDb();
  const now = Date.now();
  const record = {
    id: uuid(),
    assetId: params.assetId,
    eventId: params.eventId,
    feedbackType: params.feedbackType,
    originalStartTime: params.originalStartTime ?? null,
    originalEndTime: params.originalEndTime ?? null,
    correctedStartTime: params.correctedStartTime ?? null,
    correctedEndTime: params.correctedEndTime ?? null,
    notes: params.notes ?? null,
    createdAt: now,
  };

  db.insert(mediaEventFeedback).values(record).run();

  return record;
}

export function getFeedbackForAsset(assetId: string): EventFeedback[] {
  const db = getDb();
  const rows = db
    .select()
    .from(mediaEventFeedback)
    .where(eq(mediaEventFeedback.assetId, assetId))
    .all();
  return rows.map(parseRow);
}

export function getFeedbackForEvent(eventId: string): EventFeedback[] {
  const db = getDb();
  const rows = db
    .select()
    .from(mediaEventFeedback)
    .where(eq(mediaEventFeedback.eventId, eventId))
    .all();
  return rows.map(parseRow);
}

export function getFeedbackByType(assetId: string, feedbackType: FeedbackType): EventFeedback[] {
  if (!isValidFeedbackType(feedbackType)) {
    throw new Error(`Invalid feedback type "${feedbackType}". Must be one of: ${VALID_FEEDBACK_TYPES.join(', ')}`);
  }

  const db = getDb();
  const rows = db
    .select()
    .from(mediaEventFeedback)
    .where(and(
      eq(mediaEventFeedback.assetId, assetId),
      eq(mediaEventFeedback.feedbackType, feedbackType),
    ))
    .all();
  return rows.map(parseRow);
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

function parseRow(row: typeof mediaEventFeedback.$inferSelect): EventFeedback {
  return {
    id: row.id,
    assetId: row.assetId,
    eventId: row.eventId,
    feedbackType: row.feedbackType as FeedbackType,
    originalStartTime: row.originalStartTime,
    originalEndTime: row.originalEndTime,
    correctedStartTime: row.correctedStartTime,
    correctedEndTime: row.correctedEndTime,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}
