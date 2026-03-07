/**
 * Deterministic pre-send gate checks for notification decisions.
 *
 * These checks run after the decision engine produces a NotificationDecision
 * and before the broadcaster dispatches. They enforce hard invariants that
 * the LLM cannot override: channel availability, source-active suppression,
 * deduplication, and schema validity.
 */

import { and, eq } from "drizzle-orm";

import { getDb } from "../memory/db.js";
import { notificationEvents } from "../memory/schema.js";
import { getLogger } from "../util/logger.js";
import type { NotificationSignal } from "./signal.js";
import type { NotificationChannel, NotificationDecision } from "./types.js";

const log = getLogger("notification-deterministic-checks");

export interface CheckResult {
  passed: boolean;
  reason?: string;
}

export interface DeterministicCheckContext {
  /** Channels that are currently connected and available for delivery. */
  connectedChannels: NotificationChannel[];
  /** Dedupe window in milliseconds. Events with the same dedupeKey within this window are suppressed. */
  dedupeWindowMs?: number;
}

const DEFAULT_DEDUPE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Run all deterministic pre-send checks against a decision.
 * Returns passed=false if any check fails, with a reason describing
 * which check blocked the notification.
 */
export async function runDeterministicChecks(
  signal: NotificationSignal,
  decision: NotificationDecision,
  context: DeterministicCheckContext,
): Promise<CheckResult> {
  // Check 1: Decision schema validity (fail-closed)
  const schemaCheck = checkDecisionSchema(decision);
  if (!schemaCheck.passed) {
    log.info(
      { signalId: signal.signalId, reason: schemaCheck.reason },
      "Deterministic check failed: schema",
    );
    return schemaCheck;
  }

  // Check 2: Source-active suppression
  const sourceActiveCheck = checkSourceActiveSuppression(signal);
  if (!sourceActiveCheck.passed) {
    log.info(
      { signalId: signal.signalId, reason: sourceActiveCheck.reason },
      "Deterministic check failed: source active",
    );
    return sourceActiveCheck;
  }

  // Check 3: Channel availability
  const channelCheck = checkChannelAvailability(
    decision,
    context.connectedChannels,
  );
  if (!channelCheck.passed) {
    log.info(
      { signalId: signal.signalId, reason: channelCheck.reason },
      "Deterministic check failed: channel availability",
    );
    return channelCheck;
  }

  // Check 4: Dedupe
  const dedupeCheck = checkDedupe(
    signal,
    decision,
    context.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS,
  );
  if (!dedupeCheck.passed) {
    log.info(
      { signalId: signal.signalId, reason: dedupeCheck.reason },
      "Deterministic check failed: dedupe",
    );
    return dedupeCheck;
  }

  return { passed: true };
}

// ── Individual checks ──────────────────────────────────────────────────

/**
 * Fail-closed schema validation. If the decision is missing required
 * fields or has invalid types, block the notification.
 */
function checkDecisionSchema(decision: NotificationDecision): CheckResult {
  if (typeof decision.shouldNotify !== "boolean") {
    return {
      passed: false,
      reason: "Invalid decision: shouldNotify is not a boolean",
    };
  }
  if (!Array.isArray(decision.selectedChannels)) {
    return {
      passed: false,
      reason: "Invalid decision: selectedChannels is not an array",
    };
  }
  if (typeof decision.reasoningSummary !== "string") {
    return {
      passed: false,
      reason: "Invalid decision: reasoningSummary is not a string",
    };
  }
  if (
    typeof decision.dedupeKey !== "string" ||
    decision.dedupeKey.length === 0
  ) {
    return {
      passed: false,
      reason: "Invalid decision: dedupeKey is missing or empty",
    };
  }
  if (
    typeof decision.confidence !== "number" ||
    !Number.isFinite(decision.confidence)
  ) {
    return {
      passed: false,
      reason: "Invalid decision: confidence is not a finite number",
    };
  }
  return { passed: true };
}

/**
 * If the user is already looking at the source context (visibleInSourceNow),
 * suppress the notification to avoid redundant alerts.
 */
function checkSourceActiveSuppression(signal: NotificationSignal): CheckResult {
  if (signal.attentionHints.visibleInSourceNow) {
    return {
      passed: false,
      reason:
        "Source-active suppression: user is already viewing the source context",
    };
  }
  return { passed: true };
}

/**
 * Verify that at least one of the selected channels is actually
 * connected and available for delivery.
 */
function checkChannelAvailability(
  decision: NotificationDecision,
  connectedChannels: NotificationChannel[],
): CheckResult {
  if (!decision.shouldNotify) {
    // Not notifying — channel availability is irrelevant
    return { passed: true };
  }

  const connectedSet = new Set(connectedChannels);
  const availableSelected = decision.selectedChannels.filter((ch) =>
    connectedSet.has(ch),
  );

  if (availableSelected.length === 0) {
    return {
      passed: false,
      reason: `Channel availability: none of the selected channels (${decision.selectedChannels.join(
        ", ",
      )}) are connected`,
    };
  }

  return { passed: true };
}

/**
 * Check if a signal with the same dedupeKey was already processed
 * within the dedupe window. Uses the events-store table directly.
 */
function checkDedupe(
  signal: NotificationSignal,
  decision: NotificationDecision,
  windowMs: number,
): CheckResult {
  if (!decision.dedupeKey) {
    return { passed: true };
  }

  try {
    const db = getDb();
    const cutoff = Date.now() - windowMs;

    const existing = db
      .select({
        id: notificationEvents.id,
        createdAt: notificationEvents.createdAt,
      })
      .from(notificationEvents)
      .where(and(eq(notificationEvents.dedupeKey, decision.dedupeKey)))
      .all();

    // Filter by created_at > cutoff (the events store already checked
    // dedupe on insert, but this catches cases where the engine is
    // re-evaluating a signal that was previously stored).
    for (const row of existing) {
      // The current signal's own event row should not count as a duplicate
      if (row.id === signal.signalId) continue;
      // Only consider events within the dedupe window
      if (row.createdAt < cutoff) continue;
      // If any other event with the same dedupeKey exists within the window, suppress
      return {
        passed: false,
        reason: `Dedupe: signal with dedupeKey "${decision.dedupeKey}" was already processed`,
      };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: errMsg },
      "Dedupe check failed, allowing notification through",
    );
  }

  return { passed: true };
}
