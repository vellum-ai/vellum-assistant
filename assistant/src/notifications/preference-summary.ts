/**
 * Preference summary retriever.
 *
 * Builds a compact "notification preference summary" string for inclusion
 * in the decision engine's system prompt. Fetches all stored preferences
 * for an assistant and merges them into a coherent block that the LLM
 * can interpret when making routing decisions.
 */

import { getLogger } from '../util/logger.js';
import { listPreferences } from './preferences-store.js';
import type { AppliesWhenConditions } from './preferences-store.js';

const log = getLogger('notification-preference-summary');

/**
 * Build a compact preference summary for inclusion in the decision engine
 * system prompt. Returns null if no preferences are stored.
 */
export function getPreferenceSummary(assistantId: string): string | null {
  const preferences = listPreferences(assistantId);

  if (preferences.length === 0) {
    return null;
  }

  const lines: string[] = [
    'The user has set the following notification preferences (ordered by priority, highest first):',
  ];

  for (const pref of preferences) {
    const conditionStr = formatConditions(pref.appliesWhenJson);
    const priorityLabel = pref.priority >= 2 ? 'CRITICAL' : pref.priority === 1 ? 'override' : 'default';
    const prefix = `[${priorityLabel}]`;

    if (conditionStr) {
      lines.push(`${prefix} "${pref.preferenceText}" (when: ${conditionStr})`);
    } else {
      lines.push(`${prefix} "${pref.preferenceText}"`);
    }
  }

  log.debug({ count: preferences.length }, 'Built preference summary');

  return lines.join('\n');
}

// ── Condition formatting ────────────────────────────────────────────────

function formatConditions(appliesWhenJson: string): string {
  let conditions: AppliesWhenConditions;
  try {
    conditions = JSON.parse(appliesWhenJson);
  } catch {
    return '';
  }

  // Skip empty condition objects
  if (!conditions || typeof conditions !== 'object') return '';

  const parts: string[] = [];

  if (conditions.timeRange) {
    const { after, before } = conditions.timeRange;
    if (after && before) {
      parts.push(`${after}-${before}`);
    } else if (after) {
      parts.push(`after ${after}`);
    } else if (before) {
      parts.push(`before ${before}`);
    }
  }

  if (conditions.channels && conditions.channels.length > 0) {
    parts.push(`channels: ${conditions.channels.join(', ')}`);
  }

  if (conditions.urgencyLevels && conditions.urgencyLevels.length > 0) {
    parts.push(`urgency: ${conditions.urgencyLevels.join(', ')}`);
  }

  if (conditions.contexts && conditions.contexts.length > 0) {
    parts.push(`context: ${conditions.contexts.join(', ')}`);
  }

  return parts.join('; ');
}
