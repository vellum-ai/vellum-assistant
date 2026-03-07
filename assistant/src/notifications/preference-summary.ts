/**
 * Preference summary retriever.
 *
 * Builds a compact "notification preference summary" string for inclusion
 * in the decision engine's system prompt. Fetches all stored preferences
 * for an assistant and merges them into a coherent block that the LLM
 * can interpret when making routing decisions.
 */

import { getLogger } from "../util/logger.js";
import type { AppliesWhenConditions } from "./preferences-store.js";
import { listPreferences } from "./preferences-store.js";

const log = getLogger("notification-preference-summary");

/**
 * Build a compact preference summary for inclusion in the decision engine
 * system prompt. Returns null if no preferences are stored.
 */
export function getPreferenceSummary(): string | null {
  const preferences = listPreferences();

  if (preferences.length === 0) {
    return null;
  }

  const lines: string[] = [
    "The user has set the following notification preferences (ordered by priority, highest first):",
  ];

  for (const pref of preferences) {
    const safeText = sanitizePreferenceText(pref.preferenceText);
    const conditionStr = formatConditions(pref.appliesWhenJson);
    const priorityLabel =
      pref.priority >= 2
        ? "CRITICAL"
        : pref.priority === 1
          ? "override"
          : "default";
    const prefix = `[${priorityLabel}]`;

    if (conditionStr) {
      lines.push(`${prefix} "${safeText}" (when: ${conditionStr})`);
    } else {
      lines.push(`${prefix} "${safeText}"`);
    }
  }

  log.debug({ count: preferences.length }, "Built preference summary");

  return lines.join("\n");
}

// ── Text sanitization ───────────────────────────────────────────────────

/**
 * Strip XML/HTML-like tags from preference text to prevent prompt injection.
 * Replaces angle brackets with harmless unicode equivalents so user-authored
 * text cannot break the `<user-preferences>` framing in the system prompt.
 */
function sanitizePreferenceText(text: string): string {
  return text.replace(/</g, "\uFF1C").replace(/>/g, "\uFF1E");
}

/**
 * Safely convert and sanitize a value to a string.
 * Coerces to string first (if needed) then sanitizes with sanitizePreferenceText.
 * This ensures all values are sanitized regardless of their original type,
 * preventing prompt injection via coerced types.
 */
function safeString(value: unknown): string {
  return sanitizePreferenceText(
    typeof value === "string" ? value : String(value ?? ""),
  );
}

// ── Condition formatting ────────────────────────────────────────────────

function formatConditions(appliesWhenJson: string): string {
  let conditions: AppliesWhenConditions;
  try {
    conditions = JSON.parse(appliesWhenJson);
  } catch {
    return "";
  }

  // Skip empty condition objects
  if (!conditions || typeof conditions !== "object") return "";

  const parts: string[] = [];

  if (conditions.timeRange) {
    const after = conditions.timeRange.after
      ? safeString(conditions.timeRange.after)
      : "";
    const before = conditions.timeRange.before
      ? safeString(conditions.timeRange.before)
      : "";
    if (after && before) {
      parts.push(`${after}-${before}`);
    } else if (after) {
      parts.push(`after ${after}`);
    } else if (before) {
      parts.push(`before ${before}`);
    }
  }

  if (conditions.channels && conditions.channels.length > 0) {
    parts.push(`channels: ${conditions.channels.map(safeString).join(", ")}`);
  }

  if (conditions.urgencyLevels && conditions.urgencyLevels.length > 0) {
    parts.push(
      `urgency: ${conditions.urgencyLevels.map(safeString).join(", ")}`,
    );
  }

  if (conditions.contexts && conditions.contexts.length > 0) {
    parts.push(`context: ${conditions.contexts.map(safeString).join(", ")}`);
  }

  return parts.join("; ");
}
