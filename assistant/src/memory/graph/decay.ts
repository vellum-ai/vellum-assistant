// ---------------------------------------------------------------------------
// Memory Graph — Mechanical decay engine
//
// Runs on an hourly tick. No LLM calls — purely mathematical decay
// of emotional intensity, significance, and fidelity. Prose content
// updates (keeping content in sync with decayed values) happen during
// the LLM-based consolidation process, not here.
// ---------------------------------------------------------------------------

import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../db.js";
import { memoryGraphNodes } from "../schema.js";
import type {
  DecayCurve,
  EmotionalCharge,
  Fidelity,
  MemoryNode,
} from "./types.js";

// ---------------------------------------------------------------------------
// Emotional intensity decay
// ---------------------------------------------------------------------------

/**
 * Compute the decayed emotional intensity for a node.
 * Each decay curve behaves differently:
 *
 * - linear: constant rate of decay
 * - logarithmic: sharp initial drop, long tail (negative events)
 * - transformative: feeling changes shape — intensity drops but doesn't reach 0
 * - permanent: no decay at all
 */
export function computeDecayedIntensity(
  charge: EmotionalCharge,
  elapsedDays: number,
): number {
  if (elapsedDays <= 0) return charge.intensity;

  switch (charge.decayCurve) {
    case "permanent":
      return charge.originalIntensity;

    case "linear":
      return Math.max(
        0,
        charge.originalIntensity - charge.decayRate * elapsedDays,
      );

    case "logarithmic":
      // Sharp initial drop, long tail: I(t) = I₀ / (1 + rate × ln(1 + t))
      return (
        charge.originalIntensity /
        (1 + charge.decayRate * Math.log(1 + elapsedDays))
      );

    case "transformative":
      // Intensity drops but floors at 20% of original — the feeling transforms, doesn't vanish
      const floor = charge.originalIntensity * 0.2;
      const decayed =
        charge.originalIntensity * Math.exp(-charge.decayRate * elapsedDays);
      return Math.max(floor, decayed);

    default:
      return charge.intensity;
  }
}

// ---------------------------------------------------------------------------
// Fidelity downgrade
// ---------------------------------------------------------------------------

/** Thresholds in days for fidelity transitions (from creation or last consolidation). */
const FIDELITY_THRESHOLDS: Record<Fidelity, number> = {
  vivid: 7, // vivid for ~1 week
  clear: 30, // clear for ~1 month
  faded: 90, // faded for ~3 months
  gist: 365, // gist for ~1 year, then gone
  gone: Infinity,
};

const FIDELITY_ORDER: Fidelity[] = ["vivid", "clear", "faded", "gist", "gone"];

/**
 * Compute what fidelity level a node should be at based on elapsed time.
 * Returns null if no downgrade is needed.
 */
export function computeFidelityLevel(
  currentFidelity: Fidelity,
  elapsedDays: number,
  significance: number,
): Fidelity {
  // High-significance memories resist fidelity decay:
  // significance 0.8+ → thresholds doubled
  // significance 0.9+ → thresholds tripled
  const resistanceFactor =
    significance >= 0.9 ? 3 : significance >= 0.8 ? 2 : 1;

  let targetFidelity: Fidelity = "vivid";
  let accumulated = 0;

  for (const level of FIDELITY_ORDER) {
    if (level === "gone") {
      targetFidelity = "gist"; // don't auto-downgrade to gone — consolidation decides
      break;
    }
    accumulated += FIDELITY_THRESHOLDS[level] * resistanceFactor;
    if (elapsedDays < accumulated) {
      targetFidelity = level;
      break;
    }
    targetFidelity =
      FIDELITY_ORDER[FIDELITY_ORDER.indexOf(level) + 1] ?? "gist";
  }

  // Never upgrade fidelity — only downgrade
  const currentIdx = FIDELITY_ORDER.indexOf(currentFidelity);
  const targetIdx = FIDELITY_ORDER.indexOf(targetFidelity);
  return targetIdx > currentIdx ? targetFidelity : currentFidelity;
}

// ---------------------------------------------------------------------------
// Decay tick — processes all non-gone nodes in a scope
// ---------------------------------------------------------------------------

export interface DecayTickResult {
  nodesProcessed: number;
  emotionalDecays: number;
  fidelityDowngrades: number;
}

/**
 * Run a single decay tick. Processes all non-gone nodes in the given scope,
 * applying mechanical decay to emotional intensity and fidelity.
 *
 * Significance decay is computed at retrieval time (not stored) via
 * computeEffectiveSignificance in scoring.ts, so it's not applied here.
 */
export function runDecayTick(scopeId: string): DecayTickResult {
  const db = getDb();
  const result: DecayTickResult = {
    nodesProcessed: 0,
    emotionalDecays: 0,
    fidelityDowngrades: 0,
  };

  const rows = db
    .select()
    .from(memoryGraphNodes)
    .where(
      and(
        eq(memoryGraphNodes.scopeId, scopeId),
        sql`${memoryGraphNodes.fidelity} != 'gone'`,
      ),
    )
    .all();

  const now = Date.now();
  const msPerDay = 1000 * 60 * 60 * 24;

  for (const row of rows) {
    result.nodesProcessed++;
    const updates: Record<string, unknown> = {};

    // -- Emotional intensity decay --
    const charge: EmotionalCharge = JSON.parse(row.emotionalCharge);
    const emotionalElapsedDays = (now - row.created) / msPerDay;
    const newIntensity = computeDecayedIntensity(charge, emotionalElapsedDays);

    if (Math.abs(newIntensity - charge.intensity) > 0.001) {
      charge.intensity = newIntensity;
      updates.emotionalCharge = JSON.stringify(charge);
      result.emotionalDecays++;
    }

    // -- Fidelity downgrade --
    const currentFidelity = row.fidelity as Fidelity;
    const fidelityElapsedDays = (now - row.lastConsolidated) / msPerDay;
    const newFidelity = computeFidelityLevel(
      currentFidelity,
      fidelityElapsedDays,
      row.significance,
    );

    if (newFidelity !== currentFidelity) {
      updates.fidelity = newFidelity;
      result.fidelityDowngrades++;
    }

    // Apply updates if anything changed
    if (Object.keys(updates).length > 0) {
      db.update(memoryGraphNodes)
        .set(updates)
        .where(eq(memoryGraphNodes.id, row.id))
        .run();
    }
  }

  return result;
}
