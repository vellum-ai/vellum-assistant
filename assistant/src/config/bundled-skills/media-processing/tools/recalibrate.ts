/**
 * Recalibration tool for media event detection.
 *
 * Reads all feedback for an asset, analyzes correction patterns, and
 * re-ranks existing events using updated heuristics. Updates confidence
 * scores in the media_events table.
 *
 * All interfaces are generic — works for any event type.
 */

import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { getFeedbackForAsset, type EventFeedback } from '../services/feedback-store.js';
import { aggregateFeedback } from '../services/feedback-aggregation.js';
import { getEventsForAsset, getMediaAssetById } from '../../../../memory/media-store.js';
import { getDb } from '../../../../memory/db.js';
import { mediaEvents } from '../../../../memory/schema.js';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RecalibrationAdjustment {
  eventType: string;
  action: string;
  detail: string;
}

interface EventUpdate {
  eventId: string;
  eventType: string;
  oldConfidence: number;
  newConfidence: number;
}

// ---------------------------------------------------------------------------
// Tool entry point
// ---------------------------------------------------------------------------

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId = input.asset_id as string | undefined;
  if (!assetId) {
    return { content: 'asset_id is required.', isError: true };
  }

  const asset = getMediaAssetById(assetId);
  if (!asset) {
    return { content: `Asset "${assetId}" not found.`, isError: true };
  }

  const allFeedback = getFeedbackForAsset(assetId);
  if (allFeedback.length === 0) {
    return {
      content: JSON.stringify({
        message: 'No feedback found for this asset. Submit feedback first, then recalibrate.',
        assetId,
      }, null, 2),
      isError: false,
    };
  }

  const aggregation = aggregateFeedback(assetId);
  const allEvents = getEventsForAsset(assetId);

  // Build a map of event ID to its feedback entries
  const feedbackByEventId = new Map<string, EventFeedback[]>();
  for (const fb of allFeedback) {
    if (!feedbackByEventId.has(fb.eventId)) {
      feedbackByEventId.set(fb.eventId, []);
    }
    feedbackByEventId.get(fb.eventId)!.push(fb);
  }

  // Build a map of event ID to event type for filtering feedback by type
  const eventTypeById = new Map<string, string>();
  for (const ev of allEvents) {
    eventTypeById.set(ev.id, ev.eventType);
  }

  const adjustments: RecalibrationAdjustment[] = [];
  const eventUpdates: EventUpdate[] = [];
  const db = getDb();

  // Analyze patterns per event type
  for (const stats of aggregation.statsByEventType) {
    const { eventType, correct, incorrect, boundaryEdit, missed } = stats;
    const totalReviewed = correct + incorrect + boundaryEdit + missed;
    if (totalReviewed === 0) continue;

    // Pattern 1: High false positive rate — penalize low-confidence events
    const falsePositiveRate = totalReviewed > 0 ? incorrect / totalReviewed : 0;
    if (falsePositiveRate > 0.3 && incorrect >= 2) {
      adjustments.push({
        eventType,
        action: 'penalize_low_confidence',
        detail: `False positive rate ${(falsePositiveRate * 100).toFixed(1)}% (${incorrect}/${totalReviewed}) — reducing confidence on unreviewed events of this type`,
      });
    }

    // Pattern 2: Many missed events — note for threshold adjustment
    if (missed >= 2) {
      adjustments.push({
        eventType,
        action: 'note_missed_events',
        detail: `${missed} missed events reported — consider lowering detection threshold or adding detection rules for this type`,
      });
    }

    // Pattern 3: Boundary edits — compute average adjustment
    if (boundaryEdit >= 1) {
      const boundaryFeedback = allFeedback.filter(
        (fb) => fb.feedbackType === 'boundary_edit' && eventTypeById.get(fb.eventId) === eventType,
      );
      let startAdjTotal = 0;
      let endAdjTotal = 0;
      let startAdjCount = 0;
      let endAdjCount = 0;

      for (const fb of boundaryFeedback) {
        if (fb.originalStartTime !== null && fb.correctedStartTime !== null) {
          startAdjTotal += fb.correctedStartTime - fb.originalStartTime;
          startAdjCount++;
        }
        if (fb.originalEndTime !== null && fb.correctedEndTime !== null) {
          endAdjTotal += fb.correctedEndTime - fb.originalEndTime;
          endAdjCount++;
        }
      }

      const avgStartAdj = startAdjCount > 0 ? startAdjTotal / startAdjCount : 0;
      const avgEndAdj = endAdjCount > 0 ? endAdjTotal / endAdjCount : 0;

      if (startAdjCount > 0 || endAdjCount > 0) {
        adjustments.push({
          eventType,
          action: 'boundary_correction_pattern',
          detail: `Average boundary adjustment: start ${avgStartAdj >= 0 ? '+' : ''}${avgStartAdj.toFixed(2)}s (n=${startAdjCount}), end ${avgEndAdj >= 0 ? '+' : ''}${avgEndAdj.toFixed(2)}s (n=${endAdjCount})`,
        });
      }
    }
  }

  // Re-rank events: adjust confidence based on feedback
  for (const event of allEvents) {
    const eventFeedback = feedbackByEventId.get(event.id);
    if (!eventFeedback || eventFeedback.length === 0) {
      // For events without direct feedback, apply type-level adjustments
      const stats = aggregation.statsByEventType.find((s) => s.eventType === event.eventType);
      if (stats) {
        const totalReviewed = stats.correct + stats.incorrect + stats.boundaryEdit + stats.missed;
        const falsePositiveRate = totalReviewed > 0 ? stats.incorrect / totalReviewed : 0;

        // If high false positive rate for this type, reduce unreviewed event confidence
        if (falsePositiveRate > 0.3 && totalReviewed >= 3) {
          const penalty = Math.min(falsePositiveRate * 0.3, 0.2);
          const newConfidence = Math.max(0.05, event.confidence - penalty);
          if (newConfidence !== event.confidence) {
            db.update(mediaEvents)
              .set({ confidence: newConfidence })
              .where(eq(mediaEvents.id, event.id))
              .run();
            eventUpdates.push({
              eventId: event.id,
              eventType: event.eventType,
              oldConfidence: event.confidence,
              newConfidence,
            });
          }
        }
      }
      continue;
    }

    // Direct feedback: adjust confidence based on the latest feedback
    const latestFeedback = eventFeedback.sort((a, b) => b.createdAt - a.createdAt)[0];
    let newConfidence = event.confidence;

    switch (latestFeedback.feedbackType) {
      case 'correct':
        // Boost confidence toward 1.0
        newConfidence = Math.min(1.0, event.confidence + (1.0 - event.confidence) * 0.3);
        break;
      case 'incorrect':
        // Sharply reduce confidence
        newConfidence = Math.max(0.05, event.confidence * 0.3);
        break;
      case 'boundary_edit':
        // Slight confidence boost (event was real but boundaries were off)
        newConfidence = Math.min(1.0, event.confidence + (1.0 - event.confidence) * 0.15);
        break;
      case 'missed':
        // User-reported events keep their initial confidence
        break;
    }

    newConfidence = Math.round(newConfidence * 1000) / 1000;

    if (newConfidence !== event.confidence) {
      db.update(mediaEvents)
        .set({ confidence: newConfidence })
        .where(eq(mediaEvents.id, event.id))
        .run();
      eventUpdates.push({
        eventId: event.id,
        eventType: event.eventType,
        oldConfidence: event.confidence,
        newConfidence,
      });
    }
  }

  context.onOutput?.(`Recalibrated ${eventUpdates.length} events based on ${allFeedback.length} feedback entries.\n`);

  return {
    content: JSON.stringify({
      message: `Recalibration complete for asset ${assetId}`,
      assetId,
      totalFeedbackEntries: allFeedback.length,
      adjustments,
      eventsUpdated: eventUpdates.length,
      eventUpdates: eventUpdates.map((u) => ({
        eventId: u.eventId,
        eventType: u.eventType,
        oldConfidence: u.oldConfidence,
        newConfidence: u.newConfidence,
        delta: Math.round((u.newConfidence - u.oldConfidence) * 1000) / 1000,
      })),
      aggregation: aggregation.statsByEventType,
    }, null, 2),
    isError: false,
  };
}
