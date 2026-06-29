/**
 * Deterministic pre-send gate checks for notification decisions.
 *
 * These checks run after the decision engine produces a NotificationDecision
 * and before the broadcaster dispatches. They enforce hard invariants that
 * the LLM cannot override: channel availability, deduplication, schema
 * validity, and rendered-copy quality.
 *
 * Source-active suppression is also a hard invariant, but it depends only on
 * the signal — not on the decision — so `emitNotificationSignal` runs it as a
 * pre-decision gate, short-circuiting before the expensive LLM stage rather
 * than discarding the decision after it. See `checkSourceActiveSuppression`.
 */

import { and, eq } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import { notificationEvents } from "../persistence/schema/index.js";
import { getLogger } from "../util/logger.js";
import { composeFallbackCopy } from "./copy-composer.js";
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

  // Check 2: Channel availability
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

  // Check 3: Dedupe
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

  // Check 4: Rendered copy quality (fail-closed)
  const copyCheck = checkRenderedCopyQuality(signal, decision);
  if (!copyCheck.passed) {
    log.info(
      { signalId: signal.signalId, reason: copyCheck.reason },
      "Deterministic check failed: rendered copy quality",
    );
    return copyCheck;
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
 *
 * This depends only on the signal, not on the decision, so the outcome is
 * knowable before the decision engine runs. `emitNotificationSignal` calls it
 * as a pre-decision gate to short-circuit statically-suppressed signals
 * (e.g. trusted-contact `verification_sent`) before paying for an LLM
 * inference whose result would be discarded. Exported for that caller.
 */
export function checkSourceActiveSuppression(
  signal: NotificationSignal,
): CheckResult {
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

/**
 * Fail-closed check that the rendered copy is real text and not an
 * accidental fallback leak (empty body, or body that is just the raw
 * source event name like "user.send_notification").
 *
 * Only validates channels that the decision engine actually emitted
 * copy for. Channels appended after the decision (urgency-forced
 * `vellum` prepend, `enforceRoutingIntent` expansion) have no entry
 * in `renderedCopy` and are left for the broadcaster's
 * `composeFallbackCopy` rescue at delivery time.
 *
 * If `renderedCopy` is empty for every selected channel, the
 * broadcaster's fallback must produce a usable body — otherwise the
 * signal would be silently dropped at delivery (broadcaster skips
 * empty-body channels, `dispatchDecision` reports 0/N sent). In that
 * case, require `composeFallbackCopy` to yield a non-empty body for
 * at least one selected channel; otherwise fail-closed.
 *
 * The event-name-match branch is skipped for `assistant_tool`
 * pass-through decisions because the producer supplied the body
 * verbatim — a coincidental match with the event name is the user's
 * intent, not a fallback leak.
 */
function checkRenderedCopyQuality(
  signal: NotificationSignal,
  decision: NotificationDecision,
): CheckResult {
  if (!decision.shouldNotify) {
    return { passed: true };
  }

  const isAssistantToolPassthrough =
    decision.reasoningSummary === "assistant_tool pass-through";
  const normalizedEventName = signal.sourceEventName
    .replace(/[._]/g, " ")
    .toLowerCase()
    .trim();
  const rawEventName = signal.sourceEventName.toLowerCase();

  let anyChannelHasCopy = false;
  for (const channel of decision.selectedChannels) {
    const copy = decision.renderedCopy[channel];
    if (!copy) {
      continue;
    }
    anyChannelHasCopy = true;
    const trimmedBody = copy.body.trim();
    if (trimmedBody.length === 0) {
      return {
        passed: false,
        reason: "rendered copy body is empty",
      };
    }
    if (isAssistantToolPassthrough) {
      continue;
    }
    const normalizedBody = trimmedBody.toLowerCase();
    if (
      normalizedBody === normalizedEventName ||
      normalizedBody === rawEventName
    ) {
      return {
        passed: false,
        reason: "rendered copy body is the source event name (fallback leak)",
      };
    }
  }

  if (!anyChannelHasCopy && decision.selectedChannels.length > 0) {
    const fallback = composeFallbackCopy(signal, decision.selectedChannels);
    const fallbackUsable = decision.selectedChannels.some(
      (ch) => (fallback[ch]?.body ?? "").trim().length > 0,
    );
    if (!fallbackUsable) {
      return {
        passed: false,
        reason:
          "rendered copy missing for all selected channels and fallback body is empty (would silently drop)",
      };
    }
  }

  return { passed: true };
}
