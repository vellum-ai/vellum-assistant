/**
 * Minimal reducer store — provides helpers for the brief compiler to
 * update reducer-created state.  PR 8 will add the full transactional
 * apply logic and can extend or restructure as needed.
 */

import { eq } from "drizzle-orm";

import { getDb } from "./db.js";
import { openLoops } from "./schema.js";

/**
 * Update the `surfaced_at` timestamp on a single open loop.
 *
 * Called by the brief compiler after resurfacing a low-salience loop
 * so it is not immediately resurfaced again on the next turn.
 */
export function updateLastSurfacedAt(loopId: string, surfacedAt: number): void {
  const db = getDb();
  db.update(openLoops)
    .set({ surfacedAt, updatedAt: surfacedAt })
    .where(eq(openLoops.id, loopId))
    .run();
}
