/**
 * Generic event detection service.
 *
 * Evaluates configurable detection rules against timeline segments and produces
 * scored event candidates. The rule system is fully pluggable — callers supply
 * a DetectionConfig that specifies which rules to evaluate and how to weight them.
 *
 * Example configurations (not hardcoded — these are passed in by the caller):
 *
 *   Basketball turnovers:
 *     eventType: 'turnover'
 *     rules: [
 *       { ruleType: 'segment_transition', params: { field: 'subjects' }, weight: 0.5 },
 *       { ruleType: 'short_segment', params: { maxDurationSeconds: 5 }, weight: 0.3 },
 *       { ruleType: 'attribute_match', params: { field: 'actions', pattern: 'steal|turnover' }, weight: 0.2 },
 *     ]
 *
 *   Scene changes:
 *     eventType: 'scene_change'
 *     rules: [
 *       { ruleType: 'segment_transition', params: { field: 'segmentType' }, weight: 1.0 },
 *     ]
 */

import {
  getMediaAssetById,
  getTimelineForAsset,
  insertEventsBatch,
  deleteEventsForAsset,
  type MediaTimeline,
  type MediaEvent,
} from '../../../../memory/media-store.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DetectionRule {
  ruleType: string;
  params: Record<string, unknown>;
  weight: number;
}

export interface DetectionConfig {
  eventType: string;
  rules: DetectionRule[];
}

export interface EventCandidate {
  startTime: number;
  endTime: number;
  confidence: number;
  reasons: string[];
  metadata: Record<string, unknown>;
}

export interface DetectionResult {
  assetId: string;
  eventType: string;
  candidateCount: number;
  events: MediaEvent[];
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

interface RuleMatch {
  matched: boolean;
  reason: string;
  metadata?: Record<string, unknown>;
}

type RuleEvaluator = (
  segment: MediaTimeline,
  prevSegment: MediaTimeline | null,
  nextSegment: MediaTimeline | null,
  params: Record<string, unknown>,
) => RuleMatch;

const RULE_EVALUATORS: Record<string, RuleEvaluator> = {
  /**
   * Fires when a specified field changes between adjacent segments.
   * params.field: which attribute to compare ('subjects', 'segmentType', etc.)
   */
  segment_transition: (segment, prevSegment, _next, params) => {
    if (!prevSegment) return { matched: false, reason: '' };
    const field = (params.field as string) ?? 'segmentType';

    if (field === 'segmentType') {
      const changed = segment.segmentType !== prevSegment.segmentType;
      return {
        matched: changed,
        reason: changed
          ? `Segment type changed from "${prevSegment.segmentType}" to "${segment.segmentType}"`
          : '',
      };
    }

    // Compare attribute arrays (e.g., subjects)
    const prevAttrs = prevSegment.attributes ?? {};
    const currAttrs = segment.attributes ?? {};
    const prevValues = new Set(Array.isArray(prevAttrs[field]) ? (prevAttrs[field] as string[]) : []);
    const currValues = Array.isArray(currAttrs[field]) ? (currAttrs[field] as string[]) : [];

    if (prevValues.size === 0 && currValues.length === 0) {
      return { matched: false, reason: '' };
    }

    const overlap = currValues.filter((v) => prevValues.has(v)).length;
    const unionSize = new Set([...prevValues, ...currValues]).size;
    const similarity = unionSize > 0 ? overlap / unionSize : 0;

    // A transition is detected when similarity drops below 50%
    const changed = similarity < 0.5;
    return {
      matched: changed,
      reason: changed
        ? `${field} changed between segments (similarity: ${(similarity * 100).toFixed(0)}%)`
        : '',
      metadata: changed ? { similarity, prevValues: [...prevValues], currValues } : undefined,
    };
  },

  /**
   * Fires when a segment's duration is below a threshold.
   * params.maxDurationSeconds: maximum segment duration to trigger (default: 5)
   */
  short_segment: (segment, _prev, _next, params) => {
    const maxDuration = (params.maxDurationSeconds as number) ?? 5;
    const duration = segment.endTime - segment.startTime;
    const matched = duration > 0 && duration <= maxDuration;
    return {
      matched,
      reason: matched
        ? `Short segment (${duration.toFixed(1)}s <= ${maxDuration}s threshold)`
        : '',
      metadata: matched ? { duration } : undefined,
    };
  },

  /**
   * Fires when a segment's attribute values match a regex pattern.
   * params.field: which attribute array to search (default: 'actions')
   * params.pattern: regex pattern to match against values
   */
  attribute_match: (segment, _prev, _next, params) => {
    const field = (params.field as string) ?? 'actions';
    const pattern = params.pattern as string;
    if (!pattern) return { matched: false, reason: 'No pattern specified' };

    const attrs = segment.attributes ?? {};
    const values = Array.isArray(attrs[field]) ? (attrs[field] as string[]) : [];
    const regex = new RegExp(pattern, 'i');
    const matchedValues = values.filter((v) => regex.test(v));

    return {
      matched: matchedValues.length > 0,
      reason: matchedValues.length > 0
        ? `${field} matched pattern /${pattern}/: [${matchedValues.join(', ')}]`
        : '',
      metadata: matchedValues.length > 0 ? { matchedValues } : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// Main detection logic
// ---------------------------------------------------------------------------

/**
 * Detect events in a media asset's timeline using the provided configuration.
 *
 * For each timeline segment, evaluates all rules and computes a weighted
 * confidence score. Segments where at least one rule matches are emitted
 * as event candidates. Results are stored in the media_events table (previous
 * events of the same type for this asset are replaced).
 */
export function detectEvents(
  assetId: string,
  config: DetectionConfig,
  options?: { onProgress?: (message: string) => void },
): DetectionResult {
  const onProgress = options?.onProgress;

  const asset = getMediaAssetById(assetId);
  if (!asset) {
    throw new Error(`Media asset not found: ${assetId}`);
  }

  const segments = getTimelineForAsset(assetId);
  if (segments.length === 0) {
    throw new Error('No timeline segments found. Run timeline generation first.');
  }

  // Sort segments by start time
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);

  onProgress?.(`Evaluating ${config.rules.length} detection rules against ${sorted.length} segments...`);

  // Normalize weights so they sum to 1
  const totalWeight = config.rules.reduce((sum, r) => sum + r.weight, 0);
  const normalizedRules = totalWeight > 0
    ? config.rules.map((r) => ({ ...r, weight: r.weight / totalWeight }))
    : config.rules;

  const candidates: EventCandidate[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const segment = sorted[i];
    const prev = i > 0 ? sorted[i - 1] : null;
    const next = i < sorted.length - 1 ? sorted[i + 1] : null;

    let weightedScore = 0;
    const reasons: string[] = [];
    const candidateMetadata: Record<string, unknown> = {};
    let anyMatched = false;

    for (const rule of normalizedRules) {
      const evaluator = RULE_EVALUATORS[rule.ruleType];
      if (!evaluator) {
        reasons.push(`Unknown rule type: ${rule.ruleType}`);
        continue;
      }

      const result = evaluator(segment, prev, next, rule.params);
      if (result.matched) {
        anyMatched = true;
        weightedScore += rule.weight;
        reasons.push(result.reason);
        if (result.metadata) {
          candidateMetadata[rule.ruleType] = result.metadata;
        }
      }
    }

    if (anyMatched) {
      candidates.push({
        startTime: segment.startTime,
        endTime: segment.endTime,
        confidence: Math.min(weightedScore, 1),
        reasons,
        metadata: {
          segmentId: segment.id,
          segmentType: segment.segmentType,
          ...candidateMetadata,
        },
      });
    }
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);

  onProgress?.(`Found ${candidates.length} event candidates. Storing results...`);

  // Replace existing events of this type for the asset
  deleteEventsForAsset(assetId);

  const eventRows = candidates.map((c) => ({
    assetId,
    eventType: config.eventType,
    startTime: c.startTime,
    endTime: c.endTime,
    confidence: c.confidence,
    reasons: c.reasons,
    metadata: c.metadata,
  }));

  const events = eventRows.length > 0 ? insertEventsBatch(eventRows) : [];

  onProgress?.(`Stored ${events.length} events.`);

  return {
    assetId,
    eventType: config.eventType,
    candidateCount: candidates.length,
    events,
  };
}
