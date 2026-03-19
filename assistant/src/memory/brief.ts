/**
 * Top-level memory brief composer.
 *
 * Composes the "Time-Relevant Context" and "Open Loops" sections into a
 * single `<memory_brief>` XML-wrapped block. Omits empty sections and
 * returns an empty string when neither section has content.
 */

import { renderBriefSection } from "./brief-formatting.js";
import type { OpenLoopBriefResult } from "./brief-open-loops.js";
import { compileOpenLoopBrief } from "./brief-open-loops.js";
import { compileTimeBrief } from "./brief-time.js";
import type { DrizzleDb } from "./db-connection.js";

/** Maximum number of open-loop bullets to include in the brief. */
const MAX_OPEN_LOOP_ENTRIES = 5;

export interface MemoryBriefResult {
  /** Rendered `<memory_brief>` block, or empty string if nothing to show. */
  text: string;
  /** Forwarded from `compileOpenLoopBrief` for downstream tracking. */
  resurfacedLoopId: string | null;
}

/**
 * Compile the full memory brief block.
 *
 * @param db             Drizzle database instance
 * @param scopeId        Memory scope (e.g. assistant instance ID)
 * @param userMessageId  Current user message ID — used for deterministic
 *                       open-loop resurfacing
 * @param now            Current epoch-ms timestamp (injectable for tests)
 * @returns              `{ text, resurfacedLoopId }` — `text` is the
 *                       rendered `<memory_brief>` block or empty string
 */
export function compileMemoryBrief(
  db: DrizzleDb,
  scopeId: string,
  userMessageId: string,
  now: number = Date.now(),
): MemoryBriefResult {
  // Compile individual sections
  const timeSection = compileTimeBrief(db, scopeId, now);

  const openLoopResult: OpenLoopBriefResult = compileOpenLoopBrief(
    scopeId,
    userMessageId,
    now,
  );

  // Convert open-loop bullets to a rendered section via the shared helper
  const openLoopEntries = openLoopResult.bullets.map((b) => ({
    text: b.summary,
  }));
  const openLoopSection = renderBriefSection(
    "Open Loops",
    openLoopEntries,
    MAX_OPEN_LOOP_ENTRIES,
  );

  // Collect non-empty sections
  const sections: string[] = [];
  if (timeSection) sections.push(timeSection);
  if (openLoopSection) sections.push(openLoopSection);

  // If no sections have content, return empty
  if (sections.length === 0) {
    return { text: "", resurfacedLoopId: openLoopResult.resurfacedLoopId };
  }

  const body = sections.join("\n\n");
  const text = `<memory_brief>\n${body}\n</memory_brief>`;

  return { text, resurfacedLoopId: openLoopResult.resurfacedLoopId };
}
