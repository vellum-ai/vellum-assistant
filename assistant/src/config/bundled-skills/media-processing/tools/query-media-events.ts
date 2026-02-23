/**
 * Natural language query tool for media events.
 *
 * Accepts a free-text query and optional asset_id, parses the query into
 * structured filters via simple keyword matching, then delegates to the
 * generic retrieval service. Domain-specific keyword mappings live here;
 * the retrieval layer remains fully generic.
 */

import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { retrieveEvents, type RetrievalFilters } from '../services/retrieval-service.js';

// ---------------------------------------------------------------------------
// NL query parsing
// ---------------------------------------------------------------------------

/** Maps domain-specific keywords to canonical event type labels. */
const EVENT_TYPE_KEYWORDS: Record<string, string> = {
  // Basketball
  turnover: 'turnover',
  turnovers: 'turnover',
  steal: 'turnover',
  steals: 'turnover',
  // Soccer / football
  goal: 'goal',
  goals: 'goal',
  score: 'goal',
  scores: 'goal',
  // Generic
  highlight: 'highlight',
  highlights: 'highlight',
  scene_change: 'scene_change',
  'scene change': 'scene_change',
  'scene changes': 'scene_change',
  foul: 'foul',
  fouls: 'foul',
  shot: 'shot',
  shots: 'shot',
  rebound: 'rebound',
  rebounds: 'rebound',
  assist: 'assist',
  assists: 'assist',
  block: 'block',
  blocks: 'block',
  transition: 'transition',
  transitions: 'transition',
  fast_break: 'fast_break',
  'fast break': 'fast_break',
  'fast breaks': 'fast_break',
};

/**
 * Extract a numeric limit from phrases like "top 5", "first 3", "last 10".
 * Returns undefined if no limit phrase is found.
 */
function parseLimit(query: string): number | undefined {
  const match = query.match(/(?:top|first|last|show|find|get)\s+(\d+)/i);
  if (match) return parseInt(match[1], 10);
  // Also match trailing "N events/moments"
  const trailingMatch = query.match(/(\d+)\s+(?:events?|moments?|plays?|clips?)/i);
  if (trailingMatch) return parseInt(trailingMatch[1], 10);
  return undefined;
}

/**
 * Extract a confidence threshold from the query.
 */
function parseConfidence(query: string): number | undefined {
  const lower = query.toLowerCase();
  if (lower.includes('high confidence') || lower.includes('very confident') || lower.includes('most confident')) {
    return 0.8;
  }
  if (lower.includes('confident') || lower.includes('medium confidence')) {
    return 0.5;
  }
  // Explicit threshold: "confidence > 0.7" or "confidence above 0.7"
  const explicitMatch = lower.match(/confidence\s*(?:>|above|over|>=)\s*([\d.]+)/);
  if (explicitMatch) return parseFloat(explicitMatch[1]);
  return undefined;
}

/**
 * Extract a time range from the query (returns seconds).
 * Supports phrases like "first half", "second half", "first N minutes",
 * "last N minutes", "between M and N minutes".
 */
function parseTimeRange(query: string): { startTimeMin?: number; startTimeMax?: number } {
  const lower = query.toLowerCase();

  // "first half" / "second half" — these are relative and require knowing
  // total duration, which we don't have. Use reasonable game defaults:
  // assume ~48 min game → 2880s, half = 1440s
  if (lower.includes('first half')) {
    return { startTimeMin: 0, startTimeMax: 1440 };
  }
  if (lower.includes('second half')) {
    return { startTimeMin: 1440 };
  }

  // "first N minutes"
  const firstNMin = lower.match(/first\s+(\d+)\s*min/);
  if (firstNMin) {
    return { startTimeMin: 0, startTimeMax: parseInt(firstNMin[1], 10) * 60 };
  }

  // "last N minutes"
  // Without knowing total duration we can't compute this precisely,
  // so we skip it and let the retrieval return all results.

  // "between M and N minutes"
  const betweenMatch = lower.match(/between\s+(\d+)\s*(?:and|to|-)\s*(\d+)\s*min/);
  if (betweenMatch) {
    return {
      startTimeMin: parseInt(betweenMatch[1], 10) * 60,
      startTimeMax: parseInt(betweenMatch[2], 10) * 60,
    };
  }

  return {};
}

/**
 * Extract the event type from the query by matching known keywords.
 */
function parseEventType(query: string): string | undefined {
  const lower = query.toLowerCase();

  // Check multi-word keywords first (longer matches win)
  const multiWordKeys = Object.keys(EVENT_TYPE_KEYWORDS)
    .filter((k) => k.includes(' ') || k.includes('_'))
    .sort((a, b) => b.length - a.length);

  for (const key of multiWordKeys) {
    if (lower.includes(key)) return EVENT_TYPE_KEYWORDS[key];
  }

  // Check single-word keywords
  const words = lower.replace(/[^\w\s]/g, '').split(/\s+/);
  for (const word of words) {
    if (EVENT_TYPE_KEYWORDS[word]) return EVENT_TYPE_KEYWORDS[word];
  }

  return undefined;
}

/**
 * Parse a natural language query into structured retrieval filters.
 */
function parseQuery(query: string, assetId?: string): RetrievalFilters {
  const eventType = parseEventType(query);
  const limit = parseLimit(query);
  const minConfidence = parseConfidence(query);
  const timeRange = parseTimeRange(query);

  return {
    assetId,
    eventType,
    minConfidence,
    limit: limit ?? 10,
    sortBy: 'confidence',
    ...timeRange,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Tool entry point
// ---------------------------------------------------------------------------

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const query = input.query as string | undefined;
  if (!query) {
    return { content: 'query is required.', isError: true };
  }

  const assetId = input.asset_id as string | undefined;
  if (!assetId) {
    return { content: 'asset_id is required to scope the query to a specific media asset.', isError: true };
  }

  const filters = parseQuery(query, assetId);
  const result = retrieveEvents(filters);

  if (result.totalReturned === 0) {
    const parts = ['No matching events found'];
    if (filters.eventType) parts.push(`for event type "${filters.eventType}"`);
    if (filters.minConfidence) parts.push(`with confidence >= ${filters.minConfidence}`);
    parts.push(`in asset ${assetId}.`);
    return { content: parts.join(' '), isError: false };
  }

  const eventSummaries = result.events.map((e, i) => ({
    rank: i + 1,
    id: e.id,
    eventType: e.eventType,
    timeRange: `${formatTimestamp(e.startTime)} – ${formatTimestamp(e.endTime)}`,
    startTime: e.startTime,
    endTime: e.endTime,
    confidence: Math.round(e.confidence * 100) / 100,
    reasons: e.reasons,
    metadata: e.metadata,
  }));

  return {
    content: JSON.stringify({
      query,
      parsedFilters: {
        eventType: filters.eventType ?? null,
        minConfidence: filters.minConfidence ?? null,
        limit: filters.limit,
        startTimeMin: filters.startTimeMin ?? null,
        startTimeMax: filters.startTimeMax ?? null,
      },
      totalResults: result.totalReturned,
      events: eventSummaries,
    }, null, 2),
    isError: false,
  };
}
