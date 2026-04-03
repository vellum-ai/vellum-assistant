// ---------------------------------------------------------------------------
// Memory Graph — Trigger evaluation
// ---------------------------------------------------------------------------

import type { MemoryTrigger } from "./types.js";

export interface TriggeredResult {
  trigger: MemoryTrigger;
  /** Relevance boost from this trigger (0–1). */
  boost: number;
}

// ---------------------------------------------------------------------------
// Temporal triggers — pure date math
// ---------------------------------------------------------------------------

/**
 * Evaluate temporal triggers against the current time.
 * Schedule patterns:
 *   "day-of-week:monday"  → fires every Monday
 *   "date:04-08"          → fires on April 8 every year
 *   "time:morning"        → fires between 5 AM and 11 AM
 *   "time:afternoon"      → fires between 12 PM and 5 PM
 *   "time:evening"        → fires between 5 PM and 9 PM
 *   "time:night"          → fires between 9 PM and 5 AM
 */
export function evaluateTemporalTriggers(
  triggers: MemoryTrigger[],
  now: Date,
): TriggeredResult[] {
  const results: TriggeredResult[] = [];
  const dayNames = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const currentDay = dayNames[now.getDay()];
  const currentMonth = String(now.getMonth() + 1).padStart(2, "0");
  const currentDate = String(now.getDate()).padStart(2, "0");
  const currentHour = now.getHours();
  const dateStr = `${currentMonth}-${currentDate}`;

  for (const trigger of triggers) {
    if (trigger.type !== "temporal" || !trigger.schedule) continue;
    if (!passesCooldown(trigger, now)) continue;

    const schedule = trigger.schedule.toLowerCase();
    let fired = false;

    if (schedule.startsWith("day-of-week:")) {
      const target = schedule.slice("day-of-week:".length).trim();
      fired = currentDay === target;
    } else if (schedule.startsWith("date:")) {
      const target = schedule.slice("date:".length).trim();
      fired = dateStr === target;
    } else if (schedule.startsWith("time:")) {
      const period = schedule.slice("time:".length).trim();
      fired = matchesTimePeriod(period, currentHour);
    }

    if (fired) {
      results.push({ trigger, boost: 1.0 });
    }
  }

  return results;
}

function matchesTimePeriod(period: string, hour: number): boolean {
  switch (period) {
    case "morning":
      return hour >= 5 && hour < 12;
    case "afternoon":
      return hour >= 12 && hour < 17;
    case "evening":
      return hour >= 17 && hour < 21;
    case "night":
      return hour >= 21 || hour < 5;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Semantic triggers — cosine similarity against pre-computed embeddings
// ---------------------------------------------------------------------------

/**
 * Evaluate semantic triggers by computing cosine similarity between
 * the current conversational context embedding and each trigger's
 * pre-computed condition embedding.
 *
 * Fast: ~5ms for 50 triggers (just vector math, no LLM).
 */
export function evaluateSemanticTriggers(
  triggers: MemoryTrigger[],
  queryEmbedding: number[] | Float32Array,
): TriggeredResult[] {
  const results: TriggeredResult[] = [];

  for (const trigger of triggers) {
    if (trigger.type !== "semantic") continue;
    if (!trigger.conditionEmbedding || trigger.threshold == null) continue;
    if (trigger.consumed) continue;
    if (!passesCooldown(trigger, new Date())) continue;

    const similarity = cosineSimilarity(
      queryEmbedding,
      trigger.conditionEmbedding,
    );
    if (similarity >= trigger.threshold) {
      // Scale boost by how far above threshold (0 at threshold, 1 at similarity=1)
      const boost = Math.min(
        1.0,
        (similarity - trigger.threshold) / (1 - trigger.threshold + 0.001),
      );
      results.push({ trigger, boost: Math.max(0.5, boost) });
    }
  }

  return results;
}

/**
 * Cosine similarity between two vectors. Returns value in [-1, 1].
 */
function cosineSimilarity(
  a: number[] | Float32Array,
  b: number[] | Float32Array,
): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Event triggers — ramp function for future events
// ---------------------------------------------------------------------------

/**
 * Evaluate event triggers with a relevance ramp:
 *
 *   announced → low bg (0.05) → ramping (linear 0.05→1.0) → day-of (1.0)
 *   → decay (exponential) → 0
 */
export function evaluateEventTriggers(
  triggers: MemoryTrigger[],
  now: Date,
): TriggeredResult[] {
  const results: TriggeredResult[] = [];
  const nowMs = now.getTime();

  for (const trigger of triggers) {
    if (trigger.type !== "event" || trigger.eventDate == null) continue;

    const boost = computeEventRelevance(
      trigger.eventDate,
      trigger.rampDays ?? 7,
      trigger.followUpDays ?? 2,
      nowMs,
    );

    if (boost > 0.01) {
      results.push({ trigger, boost });
    }
  }

  return results;
}

/**
 * Compute the relevance boost for an event at the current time.
 */
function computeEventRelevance(
  eventDateMs: number,
  rampDays: number,
  followUpDays: number,
  nowMs: number,
): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysUntil = (eventDateMs - nowMs) / msPerDay;

  if (daysUntil > rampDays) {
    // Background awareness — the event exists and is coming
    return 0.05;
  }
  if (daysUntil > 0) {
    // Linear ramp from 0.05 to 1.0 over the ramp period
    return 0.05 + 0.95 * (1 - daysUntil / rampDays);
  }
  if (daysUntil > -1) {
    // Day-of: full boost
    return 1.0;
  }
  if (-daysUntil <= followUpDays) {
    // Rapid exponential decay after the event
    return Math.exp(-(-daysUntil - 1));
  }
  // Event is over
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function passesCooldown(trigger: MemoryTrigger, now: Date): boolean {
  if (!trigger.recurring) return true;
  if (!trigger.lastFired || !trigger.cooldownMs) return true;
  return now.getTime() - trigger.lastFired >= trigger.cooldownMs;
}
