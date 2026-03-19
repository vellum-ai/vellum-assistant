/**
 * Open-loop brief compiler.
 *
 * Merges reducer-created open_loops rows with live task queue (work items)
 * and follow-up state into a ranked, deduplicated list of bullets for the
 * memory brief.
 *
 * Ranking tiers (highest first):
 *   1. Overdue     — dueAt in the past
 *   2. Due ≤ 24 h  — dueAt within the next 24 hours
 *   3. Due ≤ 7 d   — dueAt within the next 7 days
 *   4. High-priority / blocked — work items at priority tier 0 or
 *      follow-ups with status "nudged"
 *   5. Recently touched — updatedAt within the last 48 hours
 *
 * After ranked items, at most ONE low-salience loop is resurfaced via
 * deterministic pseudo-random sampling seeded by `scopeId + userMessageId`.
 * The resurfaced loop's `surfacedAt` is updated so it won't repeat
 * immediately.
 */

import { and, eq } from "drizzle-orm";

import {
  type BriefFollowUp,
  getPendingAndOverdueFollowUps,
} from "../followups/followup-store.js";
import {
  type ActionableWorkItem,
  getActionableWorkItems,
} from "../tasks/task-store.js";
import { getDb } from "./db.js";
import { updateLastSurfacedAt } from "./reducer-store.js";
import { openLoops } from "./schema.js";

// ── Constants ─────────────────────────────────────────────────────────

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;
const MS_48H = 48 * 60 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────

export interface OpenLoopBullet {
  /** Dedupe key — one of `loop:<id>`, `work:<id>`, or `followup:<id>`. */
  key: string;
  summary: string;
  tier: number; // 1–5, lower = higher priority
  source: "loop" | "work_item" | "followup";
  sourceId: string;
}

export interface OpenLoopBriefResult {
  /** Bullets ordered by tier then recency. */
  bullets: OpenLoopBullet[];
  /** ID of the resurfaced low-salience loop, if any. */
  resurfacedLoopId: string | null;
}

interface OpenLoopRow {
  id: string;
  scopeId: string;
  summary: string;
  status: string;
  source: string;
  dueAt: number | null;
  surfacedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ── Deterministic hash ────────────────────────────────────────────────

/**
 * Simple 32-bit FNV-1a hash for deterministic pseudo-random selection.
 * Not cryptographic — only needs to be well-distributed for sampling.
 */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0; // unsigned 32-bit
}

// ── Tier assignment ───────────────────────────────────────────────────

function assignLoopTier(loop: OpenLoopRow, now: number): number {
  if (loop.dueAt != null) {
    if (loop.dueAt <= now) return 1; // overdue
    if (loop.dueAt <= now + MS_24H) return 2; // due within 24h
    if (loop.dueAt <= now + MS_7D) return 3; // due within 7d
  }
  if (now - loop.updatedAt <= MS_48H) return 5; // recently touched
  return 6; // low salience — candidate for resurfacing
}

function assignWorkItemTier(item: ActionableWorkItem, now: number): number {
  if (item.priorityTier === 0) return 4; // high priority
  if (item.status === "awaiting_review") return 4;
  if (now - item.updatedAt <= MS_48H) return 5;
  return 6;
}

function assignFollowUpTier(fu: BriefFollowUp, now: number): number {
  if (fu.expectedResponseBy != null && fu.expectedResponseBy <= now) return 1;
  if (fu.expectedResponseBy != null && fu.expectedResponseBy <= now + MS_24H)
    return 2;
  if (fu.expectedResponseBy != null && fu.expectedResponseBy <= now + MS_7D)
    return 3;
  if (fu.status === "nudged") return 4;
  if (now - fu.updatedAt <= MS_48H) return 5;
  return 6;
}

// ── Compiler ──────────────────────────────────────────────────────────

/**
 * Compile the open-loop section of the memory brief.
 *
 * @param scopeId   Memory scope (e.g. assistant instance ID)
 * @param userMessageId  Current user message ID — used as part of the
 *                       resurfacing seed so the selection is deterministic
 *                       per turn but varies across turns.
 * @param now       Current epoch-ms timestamp (injectable for testing).
 */
export function compileOpenLoopBrief(
  scopeId: string,
  userMessageId: string,
  now: number = Date.now(),
): OpenLoopBriefResult {
  // 1. Gather data from all three sources
  const loops = getOpenLoopsForScope(scopeId);
  const workItems = getActionableWorkItems();
  const followUps = getPendingAndOverdueFollowUps();

  // 2. Convert to bullets with tier assignment
  const bullets: OpenLoopBullet[] = [];
  const seenKeys = new Set<string>();

  // Loops first (they are the authoritative open-loop source)
  for (const loop of loops) {
    const key = `loop:${loop.id}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    bullets.push({
      key,
      summary: loop.summary,
      tier: assignLoopTier(loop, now),
      source: "loop",
      sourceId: loop.id,
    });
  }

  // Work items — skip if already represented by a loop with matching summary
  const loopSummaries = new Set(loops.map((l) => l.summary.toLowerCase()));
  for (const item of workItems) {
    const key = `work:${item.id}`;
    if (seenKeys.has(key)) continue;
    // Deduplicate against loop summaries
    if (loopSummaries.has(item.title.toLowerCase())) continue;
    seenKeys.add(key);
    bullets.push({
      key,
      summary: item.title,
      tier: assignWorkItemTier(item, now),
      source: "work_item",
      sourceId: item.id,
    });
  }

  // Follow-ups — skip if already represented by a loop
  for (const fu of followUps) {
    const key = `followup:${fu.id}`;
    if (seenKeys.has(key)) continue;
    const fuSummary =
      `Awaiting reply on ${fu.channel} (${fu.conversationId})`.toLowerCase();
    if (loopSummaries.has(fuSummary)) continue;
    seenKeys.add(key);
    bullets.push({
      key,
      summary: `Awaiting reply on ${fu.channel} (${fu.conversationId})`,
      tier: assignFollowUpTier(fu, now),
      source: "followup",
      sourceId: fu.id,
    });
  }

  // 3. Split into ranked (tiers 1–5) and low-salience (tier 6)
  const ranked: OpenLoopBullet[] = [];
  const lowSalience: OpenLoopBullet[] = [];

  for (const b of bullets) {
    if (b.tier <= 5) {
      ranked.push(b);
    } else {
      lowSalience.push(b);
    }
  }

  // Sort ranked: by tier ascending, then by source priority (loop > work > followup)
  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return sourcePriority(a.source) - sourcePriority(b.source);
  });

  // 4. Deterministic resurfacing of ONE low-salience loop
  let resurfacedLoopId: string | null = null;

  if (lowSalience.length > 0) {
    // Only consider loops from the open_loops table for resurfacing
    // (work items and follow-ups have their own lifecycle)
    const resurfaceCandidates = lowSalience.filter((b) => b.source === "loop");

    if (resurfaceCandidates.length > 0) {
      // Sort candidates deterministically by key for stable ordering
      resurfaceCandidates.sort((a, b) => a.key.localeCompare(b.key));

      const seed = `${scopeId}:${userMessageId}`;
      const hash = fnv1a(seed);
      const idx = hash % resurfaceCandidates.length;
      const picked = resurfaceCandidates[idx];

      // Promote picked to tier 5 and add to ranked output
      ranked.push({ ...picked, tier: 5 });
      resurfacedLoopId = picked.sourceId;

      // Update surfacedAt so it is deprioritised on subsequent turns
      updateLastSurfacedAt(picked.sourceId, now);
    }
  }

  // Re-sort after potential resurfaced bullet insertion
  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return sourcePriority(a.source) - sourcePriority(b.source);
  });

  return {
    bullets: ranked,
    resurfacedLoopId,
  };
}

// ── Internals ─────────────────────────────────────────────────────────

function sourcePriority(source: "loop" | "work_item" | "followup"): number {
  switch (source) {
    case "loop":
      return 0;
    case "work_item":
      return 1;
    case "followup":
      return 2;
  }
}

function getOpenLoopsForScope(scopeId: string): OpenLoopRow[] {
  const db = getDb();
  return db
    .select()
    .from(openLoops)
    .where(and(eq(openLoops.scopeId, scopeId), eq(openLoops.status, "open")))
    .all() as OpenLoopRow[];
}
