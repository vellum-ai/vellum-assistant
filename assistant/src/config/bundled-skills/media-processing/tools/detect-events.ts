import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { detectEvents, type DetectionConfig, type DetectionRule } from '../services/event-detection-service.js';

/**
 * Sensible default detection rules for common event types.
 * These are fallbacks when the caller doesn't provide explicit rules —
 * the system is not limited to these event types.
 */
const DEFAULT_RULES_BY_EVENT_TYPE: Record<string, DetectionRule[]> = {
  turnover: [
    { ruleType: 'segment_transition', params: { field: 'subjects' }, weight: 0.5 },
    { ruleType: 'short_segment', params: { maxDurationSeconds: 5 }, weight: 0.3 },
    { ruleType: 'attribute_match', params: { field: 'actions', pattern: 'steal|turnover|loss|intercept' }, weight: 0.2 },
  ],
  scene_change: [
    { ruleType: 'segment_transition', params: { field: 'segmentType' }, weight: 1.0 },
  ],
  short_play: [
    { ruleType: 'short_segment', params: { maxDurationSeconds: 3 }, weight: 0.6 },
    { ruleType: 'segment_transition', params: { field: 'subjects' }, weight: 0.4 },
  ],
};

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId = input.asset_id as string | undefined;
  if (!assetId) {
    return { content: 'asset_id is required.', isError: true };
  }

  const eventType = input.event_type as string | undefined;
  if (!eventType) {
    return { content: 'event_type is required.', isError: true };
  }

  // Parse detection rules: use provided rules or fall back to defaults
  let rules: DetectionRule[];
  const rawRules = input.detection_rules;

  if (rawRules) {
    // Accept rules as a JSON string or as an already-parsed array
    if (typeof rawRules === 'string') {
      try {
        const parsed = JSON.parse(rawRules);
        if (!Array.isArray(parsed)) {
          return { content: 'detection_rules must be a valid JSON array of rule objects.', isError: true };
        }
        rules = parsed as DetectionRule[];
      } catch {
        return { content: 'detection_rules must be a valid JSON array of rule objects.', isError: true };
      }
    } else if (Array.isArray(rawRules)) {
      rules = rawRules as DetectionRule[];
    } else {
      return { content: 'detection_rules must be an array of rule objects.', isError: true };
    }

    // Validate each rule has the required shape
    for (const rule of rules) {
      if (!rule.ruleType || typeof rule.ruleType !== 'string') {
        return { content: 'Each detection rule must have a "ruleType" string.', isError: true };
      }
      if (rule.weight === undefined || typeof rule.weight !== 'number') {
        return { content: 'Each detection rule must have a "weight" number.', isError: true };
      }
      if (!rule.params || typeof rule.params !== 'object') {
        return { content: 'Each detection rule must have a "params" object.', isError: true };
      }
    }
  } else {
    // Use defaults for known event types, or a generic transition-based fallback
    rules = DEFAULT_RULES_BY_EVENT_TYPE[eventType] ?? [
      { ruleType: 'segment_transition', params: { field: 'segmentType' }, weight: 0.6 },
      { ruleType: 'short_segment', params: { maxDurationSeconds: 5 }, weight: 0.4 },
    ];
  }

  const config: DetectionConfig = { eventType, rules };

  try {
    const result = detectEvents(assetId, config, {
      onProgress: (msg) => context.onOutput?.(`${msg}\n`),
    });

    return {
      content: JSON.stringify({
        message: `Detected ${result.candidateCount} ${result.eventType} events`,
        assetId: result.assetId,
        eventType: result.eventType,
        totalEvents: result.candidateCount,
        rulesUsed: rules.map((r) => r.ruleType),
        events: result.events.map((e) => ({
          id: e.id,
          startTime: e.startTime,
          endTime: e.endTime,
          confidence: e.confidence,
          reasons: e.reasons,
        })),
      }, null, 2),
      isError: false,
    };
  } catch (err) {
    return {
      content: `Event detection failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
