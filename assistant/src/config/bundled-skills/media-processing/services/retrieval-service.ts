/**
 * Generic media event retrieval service.
 *
 * Pure data retrieval with configurable filters and ranking — no
 * domain-specific logic. Callers (e.g. a query tool) are responsible
 * for translating domain concepts into filter parameters.
 */

import {
  getEventsForAsset,
  type MediaEvent,
} from '../../../../memory/media-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrievalFilters {
  /** Scope results to a specific media asset. */
  assetId?: string;
  /** Filter by event type label. */
  eventType?: string;
  /** Minimum confidence threshold (0–1). */
  minConfidence?: number;
  /** Maximum number of results to return. */
  limit?: number;
  /** Sort order for results. */
  sortBy?: 'confidence' | 'startTime';
  /** Only return events that start at or after this time (seconds). */
  startTimeMin?: number;
  /** Only return events that start at or before this time (seconds). */
  startTimeMax?: number;
}

export interface RetrievalResult {
  events: MediaEvent[];
  totalReturned: number;
  filters: RetrievalFilters;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Query the media_events table with the given filters and return ranked
 * results with full event metadata.
 *
 * When `assetId` is not provided the function returns an empty result set
 * because the underlying store requires an asset scope. Callers that want
 * cross-asset queries should iterate over asset IDs externally.
 */
export function retrieveEvents(filters: RetrievalFilters): RetrievalResult {
  const {
    assetId,
    eventType,
    minConfidence,
    limit = 10,
    sortBy = 'confidence',
    startTimeMin,
    startTimeMax,
  } = filters;

  if (!assetId) {
    return { events: [], totalReturned: 0, filters };
  }

  // Fetch from the store with the subset of filters it supports natively
  let events = getEventsForAsset(assetId, {
    eventType,
    minConfidence,
    sortBy,
    // Fetch more than needed so we can apply time-range filtering locally
    limit: startTimeMin !== undefined || startTimeMax !== undefined ? undefined : limit,
  });

  // Apply time-range filters that the store doesn't support directly
  if (startTimeMin !== undefined) {
    events = events.filter((e) => e.startTime >= startTimeMin);
  }
  if (startTimeMax !== undefined) {
    events = events.filter((e) => e.startTime <= startTimeMax);
  }

  // Re-apply limit after local filtering
  if (limit && events.length > limit) {
    events = events.slice(0, limit);
  }

  return {
    events,
    totalReturned: events.length,
    filters,
  };
}
