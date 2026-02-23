/**
 * Tool for submitting feedback on media events.
 *
 * Supports four feedback types:
 *   - correct: confirms the event is accurate
 *   - incorrect: marks a false positive
 *   - boundary_edit: adjusts start/end times
 *   - missed: reports an event the system failed to detect (creates a new event)
 *
 * All interfaces are generic — works for any event type.
 */

import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { submitFeedback, type FeedbackType } from '../services/feedback-store.js';
import { getEventById, insertEvent, getMediaAssetById } from '../../../../memory/media-store.js';

const VALID_FEEDBACK_TYPES = ['correct', 'incorrect', 'boundary_edit', 'missed'];

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const feedbackType = input.feedback_type as string | undefined;
  if (!feedbackType || !VALID_FEEDBACK_TYPES.includes(feedbackType)) {
    return {
      content: `feedback_type is required and must be one of: ${VALID_FEEDBACK_TYPES.join(', ')}`,
      isError: true,
    };
  }

  // For 'missed' type, we need asset_id and event details to create the missing event
  if (feedbackType === 'missed') {
    return handleMissedEvent(input, feedbackType as FeedbackType);
  }

  // For all other types, event_id is required
  const eventId = input.event_id as string | undefined;
  if (!eventId) {
    return { content: 'event_id is required for feedback types other than "missed".', isError: true };
  }

  const event = getEventById(eventId);
  if (!event) {
    return { content: `Event "${eventId}" not found.`, isError: true };
  }

  const correctedStartTime = input.corrected_start_time as number | undefined;
  const correctedEndTime = input.corrected_end_time as number | undefined;
  const notes = input.notes as string | undefined;

  // For boundary_edit, at least one corrected time should be provided
  if (feedbackType === 'boundary_edit' && correctedStartTime === undefined && correctedEndTime === undefined) {
    return {
      content: 'For boundary_edit feedback, at least one of corrected_start_time or corrected_end_time is required.',
      isError: true,
    };
  }

  const feedback = submitFeedback({
    assetId: event.assetId,
    eventId: event.id,
    feedbackType: feedbackType as FeedbackType,
    originalStartTime: event.startTime,
    originalEndTime: event.endTime,
    correctedStartTime: correctedStartTime ?? null,
    correctedEndTime: correctedEndTime ?? null,
    notes: notes ?? null,
  });

  return {
    content: JSON.stringify({
      message: `Feedback submitted: ${feedbackType} for event ${eventId}`,
      feedbackId: feedback.id,
      eventId: event.id,
      assetId: event.assetId,
      feedbackType: feedback.feedbackType,
      ...(correctedStartTime !== undefined ? { correctedStartTime } : {}),
      ...(correctedEndTime !== undefined ? { correctedEndTime } : {}),
    }, null, 2),
    isError: false,
  };
}

function handleMissedEvent(
  input: Record<string, unknown>,
  feedbackType: FeedbackType,
): ToolExecutionResult {
  const assetId = input.asset_id as string | undefined;
  if (!assetId) {
    return { content: 'asset_id is required for "missed" feedback type.', isError: true };
  }

  const asset = getMediaAssetById(assetId);
  if (!asset) {
    return { content: `Asset "${assetId}" not found.`, isError: true };
  }

  const eventType = input.event_type as string | undefined;
  if (!eventType) {
    return { content: 'event_type is required for "missed" feedback type.', isError: true };
  }

  const startTime = input.start_time as number | undefined;
  const endTime = input.end_time as number | undefined;
  if (startTime === undefined || endTime === undefined) {
    return { content: 'start_time and end_time are required for "missed" feedback type.', isError: true };
  }

  if (endTime <= startTime) {
    return { content: 'end_time must be greater than start_time.', isError: true };
  }

  const notes = input.notes as string | undefined;

  // Create the missing event with low confidence (user-reported)
  const newEvent = insertEvent({
    assetId,
    eventType,
    startTime,
    endTime,
    confidence: 0.5,
    reasons: ['user_reported_missed_event'],
    metadata: { source: 'user_feedback', notes: notes ?? null },
  });

  // Store the feedback referencing the newly created event
  const feedback = submitFeedback({
    assetId,
    eventId: newEvent.id,
    feedbackType,
    originalStartTime: null,
    originalEndTime: null,
    correctedStartTime: startTime,
    correctedEndTime: endTime,
    notes: notes ?? null,
  });

  return {
    content: JSON.stringify({
      message: `Missed event reported and created: ${eventType} at ${startTime}s-${endTime}s`,
      feedbackId: feedback.id,
      newEventId: newEvent.id,
      assetId,
      eventType,
      startTime,
      endTime,
    }, null, 2),
    isError: false,
  };
}
