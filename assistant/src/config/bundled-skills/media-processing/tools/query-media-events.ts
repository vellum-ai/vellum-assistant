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
import { getTrackingProfile, type CapabilityTier } from '../../../../memory/media-store.js';
import { getCapabilitiesByTier, getCapabilityByName } from '../services/capability-registry.js';

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

  // Retrieve without limit so we can apply capability filtering first, then limit
  const userLimit = filters.limit;
  const result = retrieveEvents({ ...filters, limit: 0 });

  // Determine which capabilities are allowed based on the tracking profile
  const profile = getTrackingProfile(assetId);

  let allowedEventTypes: Set<string> | null = null;
  const tierForEventType = new Map<string, CapabilityTier>();

  if (profile) {
    // Use the explicit profile: only enabled capabilities pass
    allowedEventTypes = new Set<string>();
    for (const [capName, entry] of Object.entries(profile.capabilities)) {
      if (entry.enabled) {
        allowedEventTypes.add(capName);
        tierForEventType.set(capName, entry.tier);
      }
    }
  } else {
    // No profile: default to 'ready' tier capabilities only
    const readyCaps = getCapabilitiesByTier('ready');
    if (readyCaps.length > 0) {
      allowedEventTypes = new Set(readyCaps.map((c) => c.name));
      for (const cap of readyCaps) {
        tierForEventType.set(cap.name, 'ready');
      }
    }
    // If no capabilities are registered at all, allow everything (pass null)
  }

  // Filter events by allowed capabilities, then apply the user-requested limit
  let filteredEvents = result.events;
  if (allowedEventTypes !== null) {
    filteredEvents = filteredEvents.filter((e) => allowedEventTypes!.has(e.eventType));
  }
  if (userLimit && filteredEvents.length > userLimit) {
    filteredEvents = filteredEvents.slice(0, userLimit);
  }

  if (filteredEvents.length === 0) {
    const parts = ['No matching events found'];
    if (filters.eventType) parts.push(`for event type "${filters.eventType}"`);
    if (filters.minConfidence) parts.push(`with confidence >= ${filters.minConfidence}`);
    if (!profile) parts.push('(defaulting to ready-tier capabilities only)');
    parts.push(`in asset ${assetId}.`);
    return { content: parts.join(' '), isError: false };
  }

  const tierLabels: Record<string, string> = {
    ready: '[Ready]',
    beta: '[Beta]',
    experimental: '[Experimental]',
  };

  const tierDisclaimers: Record<string, string> = {
    beta: 'Beta results may have accuracy gaps.',
    experimental: 'Experimental results are early-stage; expect noise.',
  };

  const eventSummaries = filteredEvents.map((e, i) => {
    const tier = tierForEventType.get(e.eventType) ?? getCapabilityByName(e.eventType)?.tier;
    const tierLabel = tier ? tierLabels[tier] ?? `[${tier}]` : '[Ready]';
    const disclaimer = tier ? tierDisclaimers[tier] : undefined;

    return {
      rank: i + 1,
      id: e.id,
      eventType: e.eventType,
      tierLabel,
      ...(disclaimer ? { confidenceDisclaimer: disclaimer } : {}),
      timeRange: `${formatTimestamp(e.startTime)} – ${formatTimestamp(e.endTime)}`,
      startTime: e.startTime,
      endTime: e.endTime,
      confidence: Math.round(e.confidence * 100) / 100,
      reasons: e.reasons,
      metadata: e.metadata,
    };
  });

  // Collect disclaimers for any non-ready tiers present in results
  const activeTiers = new Set(eventSummaries.map((e) => e.tierLabel));
  const disclaimers: string[] = [];
  if (activeTiers.has('[Beta]')) disclaimers.push(tierDisclaimers.beta);
  if (activeTiers.has('[Experimental]')) disclaimers.push(tierDisclaimers.experimental);

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
      trackingProfile: profile ? 'custom' : 'default (ready tier only)',
      ...(disclaimers.length > 0 ? { disclaimers } : {}),
      totalResults: eventSummaries.length,
      events: eventSummaries,
    }, null, 2),
    isError: false,
  };
}
