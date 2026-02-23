/**
 * Feedback aggregation service for media events.
 *
 * Computes precision/recall estimates per event type based on user feedback,
 * and provides structured JSON export for offline analysis.
 *
 * All interfaces are generic — works for any event type.
 */

import { getFeedbackForAsset, type EventFeedback } from './feedback-store.js';
import { getEventsForAsset } from '../../../../memory/media-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventTypeStats {
  eventType: string;
  totalEvents: number;
  correct: number;
  incorrect: number;
  boundaryEdit: number;
  missed: number;
  totalFeedback: number;
  precision: number | null;
  recall: number | null;
}

export interface AggregationResult {
  assetId: string;
  totalFeedbackEntries: number;
  statsByEventType: EventTypeStats[];
}

export interface FeedbackExport {
  assetId: string;
  exportedAt: string;
  totalEntries: number;
  feedback: EventFeedback[];
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Compute precision/recall estimates per event type for a given asset.
 *
 * precision = correct / (correct + incorrect)
 * recall = (correct + boundary_edit) / (correct + boundary_edit + missed)
 *
 * Returns null for precision/recall when the denominator is zero.
 */
export function aggregateFeedback(assetId: string): AggregationResult {
  const allFeedback = getFeedbackForAsset(assetId);
  const allEvents = getEventsForAsset(assetId);

  // Group feedback by event type — we need event type from the events table
  const eventTypeById = new Map<string, string>();
  for (const event of allEvents) {
    eventTypeById.set(event.id, event.eventType);
  }

  // Collect counts per event type
  const countsMap = new Map<string, {
    correct: number;
    incorrect: number;
    boundaryEdit: number;
    missed: number;
    totalEvents: number;
  }>();

  // Initialize with known event types from existing events
  for (const event of allEvents) {
    if (!countsMap.has(event.eventType)) {
      countsMap.set(event.eventType, { correct: 0, incorrect: 0, boundaryEdit: 0, missed: 0, totalEvents: 0 });
    }
    countsMap.get(event.eventType)!.totalEvents++;
  }

  // Tally feedback
  for (const fb of allFeedback) {
    const eventType = eventTypeById.get(fb.eventId);
    if (!eventType) continue;

    if (!countsMap.has(eventType)) {
      countsMap.set(eventType, { correct: 0, incorrect: 0, boundaryEdit: 0, missed: 0, totalEvents: 0 });
    }

    const counts = countsMap.get(eventType)!;
    switch (fb.feedbackType) {
      case 'correct':
        counts.correct++;
        break;
      case 'incorrect':
        counts.incorrect++;
        break;
      case 'boundary_edit':
        counts.boundaryEdit++;
        break;
      case 'missed':
        counts.missed++;
        break;
    }
  }

  const statsByEventType: EventTypeStats[] = [];
  for (const [eventType, counts] of countsMap) {
    const precisionDenom = counts.correct + counts.incorrect;
    const recallDenom = counts.correct + counts.boundaryEdit + counts.missed;

    statsByEventType.push({
      eventType,
      totalEvents: counts.totalEvents,
      correct: counts.correct,
      incorrect: counts.incorrect,
      boundaryEdit: counts.boundaryEdit,
      missed: counts.missed,
      totalFeedback: counts.correct + counts.incorrect + counts.boundaryEdit + counts.missed,
      precision: precisionDenom > 0 ? counts.correct / precisionDenom : null,
      recall: recallDenom > 0 ? (counts.correct + counts.boundaryEdit) / recallDenom : null,
    });
  }

  return {
    assetId,
    totalFeedbackEntries: allFeedback.length,
    statsByEventType,
  };
}

/**
 * Export all feedback for an asset as structured JSON for offline analysis.
 */
export function exportFeedback(assetId: string): FeedbackExport {
  const allFeedback = getFeedbackForAsset(assetId);

  return {
    assetId,
    exportedAt: new Date().toISOString(),
    totalEntries: allFeedback.length,
    feedback: allFeedback,
  };
}
