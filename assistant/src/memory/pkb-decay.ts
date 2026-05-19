/**
 * Hourly decay worker for the personal-knowledge base.
 *
 * Anchors decay on `last_reinforced_at` (entities + preferences). The
 * mathematical model is an exponential half-life: confidence multiplied
 * by `0.5 ** (elapsedDays / halfLifeDays)` each tick. The worker writes
 * the decayed value back so future scoring reads from a stored truth
 * rather than an ephemeral derivation.
 *
 * No LLM calls — purely mathematical. Mirrors the pattern in
 * `assistant/src/memory/graph/decay.ts`.
 *
 * The worker is feature-flagged: callers wire it into the scheduler
 * only when `memory-maturation` is enabled.
 */

import { eq, gt } from "drizzle-orm";

import { getLogger } from "../util/logger.js";
import { getDb } from "./db-connection.js";
import { pkbEntities, pkbPreferences } from "./schema.js";

const log = getLogger("pkb-decay");

export interface DecayOptions {
  /** Reference clock, defaults to `Date.now()`. */
  now?: number;
  /** Confidence half-life in days. Default 30 days. */
  entityHalfLifeDays?: number;
  /** Confidence half-life in days for preferences. Default 45 days. */
  preferenceHalfLifeDays?: number;
  /**
   * Floor below which we stop decaying — keeps low-confidence rows from
   * asymptotically chasing zero forever. Default 0.05.
   */
  confidenceFloor?: number;
}

export interface DecayMetrics {
  entitiesScanned: number;
  entitiesUpdated: number;
  preferencesScanned: number;
  preferencesUpdated: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Run one decay pass. Safe to invoke at startup and on every cron tick.
 * Never throws — degrades to a structured log on unexpected errors.
 */
export function runPkbDecayPass(options: DecayOptions = {}): DecayMetrics {
  const now = options.now ?? Date.now();
  const entityHalfLifeDays = clampPositive(options.entityHalfLifeDays ?? 30);
  const prefHalfLifeDays = clampPositive(options.preferenceHalfLifeDays ?? 45);
  const floor = Math.max(0, Math.min(0.99, options.confidenceFloor ?? 0.05));

  let entitiesScanned = 0;
  let entitiesUpdated = 0;
  let preferencesScanned = 0;
  let preferencesUpdated = 0;

  try {
    const db = getDb();

    const entityRows = db
      .select({
        id: pkbEntities.id,
        confidence: pkbEntities.confidence,
        lastReinforcedAt: pkbEntities.lastReinforcedAt,
        lastSeenAt: pkbEntities.lastSeenAt,
      })
      .from(pkbEntities)
      .where(gt(pkbEntities.confidence, floor))
      .all();
    entitiesScanned = entityRows.length;

    for (const row of entityRows) {
      const anchor = row.lastReinforcedAt ?? row.lastSeenAt;
      if (anchor >= now) continue;
      const elapsedDays = (now - anchor) / ONE_DAY_MS;
      const decayFactor = Math.pow(0.5, elapsedDays / entityHalfLifeDays);
      const decayed = Math.max(floor, row.confidence * decayFactor);
      if (Math.abs(decayed - row.confidence) < 1e-6) continue;
      db.update(pkbEntities)
        .set({ confidence: decayed, updatedAt: now })
        .where(eq(pkbEntities.id, row.id))
        .run();
      entitiesUpdated += 1;
    }

    const prefRows = db
      .select({
        id: pkbPreferences.id,
        confidence: pkbPreferences.confidence,
        lastReinforcedAt: pkbPreferences.lastReinforcedAt,
        updatedAt: pkbPreferences.updatedAt,
      })
      .from(pkbPreferences)
      .where(gt(pkbPreferences.confidence, floor))
      .all();
    preferencesScanned = prefRows.length;

    for (const row of prefRows) {
      const anchor = row.lastReinforcedAt ?? row.updatedAt;
      if (anchor >= now) continue;
      const elapsedDays = (now - anchor) / ONE_DAY_MS;
      const decayFactor = Math.pow(0.5, elapsedDays / prefHalfLifeDays);
      const decayed = Math.max(floor, row.confidence * decayFactor);
      if (Math.abs(decayed - row.confidence) < 1e-6) continue;
      db.update(pkbPreferences)
        .set({ confidence: decayed, updatedAt: now })
        .where(eq(pkbPreferences.id, row.id))
        .run();
      preferencesUpdated += 1;
    }
  } catch (err) {
    log.warn({ err }, "pkb decay pass failed");
  }

  log.debug(
    {
      entitiesScanned,
      entitiesUpdated,
      preferencesScanned,
      preferencesUpdated,
    },
    "pkb decay pass complete",
  );

  return {
    entitiesScanned,
    entitiesUpdated,
    preferencesScanned,
    preferencesUpdated,
  };
}

function clampPositive(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}
