// ---------------------------------------------------------------------------
// Memory Graph — Context assembly and injection tracking
// ---------------------------------------------------------------------------

import { optimizeImageForTransport } from "../../agent/image-optimize.js";
import { getLogger } from "../../util/logger.js";
import { loadImageRefData } from "./image-ref-utils.js";
import type { MemoryNode, ScoredNode } from "./types.js";
import { isCapabilityNode } from "./types.js";

// ---------------------------------------------------------------------------
// Image injection budgets
// ---------------------------------------------------------------------------

export const MAX_CONTEXT_LOAD_IMAGES = 3;
export const MAX_PER_TURN_IMAGES = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedImage {
  base64Data: string;
  mediaType: string;
  description: string;
}

// ---------------------------------------------------------------------------
// InContextTracker — tracks which node IDs are visible to the LLM
// ---------------------------------------------------------------------------

interface InjectionLogEntry {
  nodeId: string;
  turn: number;
}

/**
 * Tracks which memory graph nodes are currently in the LLM's context.
 * Handles:
 * - Deduplication: never re-inject a node already visible
 * - Compaction eviction: when context compaction removes turns,
 *   evict those nodes so they can be re-injected if relevant later
 */
export class InContextTracker {
  private inContext = new Set<string>();
  private log: InjectionLogEntry[] = [];
  private currentTurn = 0;

  /** Mark nodes as loaded into context. */
  add(nodeIds: string[]): void {
    for (const id of nodeIds) {
      this.inContext.add(id);
      this.log.push({ nodeId: id, turn: this.currentTurn });
    }
  }

  /** Check if a node is already in context. */
  isInContext(nodeId: string): boolean {
    return this.inContext.has(nodeId);
  }

  /** Filter candidates to only those not already in context. */
  filterNew(candidates: ScoredNode[]): ScoredNode[] {
    return candidates.filter((c) => !this.inContext.has(c.node.id));
  }

  /** Advance the turn counter. Called before each retrieval step. */
  advanceTurn(): void {
    this.currentTurn++;
  }

  /**
   * Evict nodes that were injected in compacted turns.
   * Called when context compaction removes message history.
   */
  evictCompactedTurns(upToTurn: number): void {
    const evicted: string[] = [];
    this.log = this.log.filter((entry) => {
      if (entry.turn <= upToTurn) {
        evicted.push(entry.nodeId);
        return false;
      }
      return true;
    });

    // Only evict if the node isn't also loaded in a later turn
    const stillPresent = new Set(this.log.map((e) => e.nodeId));
    for (const id of evicted) {
      if (!stillPresent.has(id)) {
        this.inContext.delete(id);
      }
    }
  }

  /** Get all node IDs currently in context. Useful for extraction. */
  getActiveNodeIds(): string[] {
    return [...this.inContext];
  }

  /** Get the injection log. Useful for debugging. */
  getLog(): InjectionLogEntry[] {
    return [...this.log];
  }

  /** Current turn number. */
  getTurn(): number {
    return this.currentTurn;
  }
}

// ---------------------------------------------------------------------------
// Context assembly — programmatic, not LLM
//
// Each node's full prose lives in node.content. The context block gets a
// compressed version: 1-2 sentences + light metadata (type, age).
// Full detail available via the recall tool.
// ---------------------------------------------------------------------------

// No assembly options needed — the retriever's node count (30-40) is the only limit.
// The context block includes full node content.

/** Format relative time from epoch ms. */
function relativeAge(createdMs: number): string {
  const diffMs = Date.now() - createdMs;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 90) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/**
 * Format an event date as a human-readable string with relative countdown.
 * Examples:
 *   "Tue Apr 8, 6:00 PM (in 3d)"
 *   "Thu Apr 10 (in 5d)"
 *   "Mon Apr 7, 9:00 AM (tomorrow)"
 *   "Wed Apr 1 (today)"
 */
export function formatEventDate(epochMs: number): string {
  const date = new Date(epochMs);
  const now = new Date();

  // Day names and month names
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const dayName = dayNames[date.getDay()];
  const monthName = monthNames[date.getMonth()];
  const dayOfMonth = date.getDate();

  // Heuristic: date-only events are stored as midnight UTC, so we treat
  // midnight-UTC epochs as "no time component".  This is lossy — a timed event
  // genuinely scheduled at 00:00 UTC will have its time display silently dropped.
  // Fixing this properly requires the event storage layer to carry an explicit
  // `hasTime` flag; until then this is the best available approximation.
  // Use UTC methods so west-of-UTC local offsets don't defeat the check.
  const hasTime = date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0;
  let datePart = `${dayName} ${monthName} ${dayOfMonth}`;
  if (hasTime) {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? "PM" : "AM";
    const displayHour = hours % 12 || 12;
    const timePart =
      minutes === 0
        ? `${displayHour}:00 ${ampm}`
        : `${displayHour}:${String(minutes).padStart(2, "0")} ${ampm}`;
    datePart += `, ${timePart}`;
  }

  // Calculate relative countdown using calendar days
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const eventStart = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const diffDays = Math.round(
    (eventStart.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24),
  );

  let relative: string;
  if (diffDays === 0) {
    relative = "today";
  } else if (diffDays === -1) {
    // For date-only inputs (no time component), -1 day can be UTC midnight drift — treat as "today".
    // For timed events, -1 day is genuinely yesterday.
    relative = hasTime ? "yesterday" : "today";
  } else if (diffDays < -1) {
    // Past dates
    const absDays = -diffDays;
    if (absDays < 14) {
      relative = `${absDays}d ago`;
    } else if (absDays < 60) {
      relative = `${Math.floor(absDays / 7)}w ago`;
    } else {
      relative = `${Math.floor(absDays / 30)}mo ago`;
    }
  } else if (diffDays === 1) {
    relative = "tomorrow";
  } else if (diffDays < 14) {
    relative = `in ${diffDays}d`;
  } else if (diffDays < 60) {
    relative = `in ${Math.floor(diffDays / 7)}w`;
  } else {
    relative = `in ${Math.floor(diffDays / 30)}mo`;
  }

  return `${datePart} (${relative})`;
}

/** Format an upcoming entry — uses event date when available, falls back to standard format. */
function formatUpcomingEntry(scored: ScoredNode): string {
  const node = scored.node;
  if (node.eventDate != null) {
    return `- ${formatEventDate(node.eventDate)} — ${node.content}`;
  }
  return formatNodeEntry(scored);
}

/** Format a single node for the context block. */
function formatNodeEntry(scored: ScoredNode): string {
  const node = scored.node;
  const age = relativeAge(node.created);
  let entry = `- (${age}) ${node.content}`;
  if (node.imageRefs && node.imageRefs.length > 0) {
    const desc = node.imageRefs[0]!.description;
    entry += ` [image: ${desc}]`;
  }
  return entry;
}

/**
 * Assemble a context block from scored memory nodes.
 *
 * Structure:
 * - Right Now: present-tense state (most recent emotional + very recent episodic)
 * - Active Threads: prospective nodes (commitments, tasks, plans)
 * - What Today Means: date-triggered nodes (anniversaries, milestones)
 * - On My Mind: everything else, ordered by score — no sub-categories
 * - Serendipity: the random mid-tier wildcard(s)
 */
export function assembleContextBlock(
  nodes: ScoredNode[],
  options?: { serendipityNodes?: ScoredNode[] },
): string {
  // Partition nodes into sections
  const rightNow: ScoredNode[] = [];
  const threads: ScoredNode[] = [];
  const triggered: ScoredNode[] = [];
  const upcoming: ScoredNode[] = [];
  const capabilities: ScoredNode[] = [];
  const onMyMind: ScoredNode[] = [];

  for (const scored of nodes) {
    const node = scored.node;

    if (scored.scoreBreakdown.triggerBoost > 0) {
      triggered.push(scored);
    } else if (node.eventDate != null && node.eventDate > Date.now()) {
      // Future-dated events without an active trigger go to Upcoming
      upcoming.push(scored);
    } else if (node.type === "prospective") {
      threads.push(scored);
    } else if (isCapabilityNode(node)) {
      capabilities.push(scored);
    } else if (node.type === "emotional" && isRecent(node)) {
      // Recent emotional nodes go in "Right Now" — present-tense state
      rightNow.push(scored);
    } else if (isVeryRecent(node)) {
      // Very recent nodes (last few hours) are "right now" context
      rightNow.push(scored);
    } else {
      onMyMind.push(scored);
    }
  }

  // Sort upcoming by eventDate ascending (soonest first)
  upcoming.sort((a, b) => (a.node.eventDate ?? 0) - (b.node.eventDate ?? 0));

  const parts: string[] = [];

  // --- Right Now ---
  if (rightNow.length > 0) {
    const entries = buildSection(rightNow, 3);
    if (entries.length > 0) {
      parts.push(`### Right Now\n${entries.join("\n")}`);
    }
  }

  // --- Active Threads ---
  if (threads.length > 0) {
    const entries = buildSection(threads, 5);
    if (entries.length > 0) {
      parts.push(`### Active Threads\n${entries.join("\n")}`);
    }
  }

  // --- Skills You Can Use ---
  if (capabilities.length > 0) {
    const entries = capabilities.slice(0, 5).map((scored) => {
      const content = scored.node.content.replace(/^(?:skill|cli):\S+\n/, "");
      return `- ${content} → use skill_load to activate`;
    });
    parts.push(`### Skills You Can Use\n${entries.join("\n")}`);
  }

  // --- Upcoming ---
  if (upcoming.length > 0) {
    const entries = upcoming.slice(0, 5).map(formatUpcomingEntry);
    if (entries.length > 0) {
      parts.push(`### Upcoming\n${entries.join("\n")}`);
    }
  }

  // --- What Today Means ---
  if (triggered.length > 0) {
    const entries = buildSection(triggered, 3);
    if (entries.length > 0) {
      parts.push(`### What Today Means\n${entries.join("\n")}`);
    }
  }

  // --- On My Mind ---
  if (onMyMind.length > 0) {
    const entries = buildSection(onMyMind, onMyMind.length);
    if (entries.length > 0) {
      parts.push(`### On My Mind\n${entries.join("\n")}`);
    }
  }

  // --- Serendipity ---
  const serendipity = options?.serendipityNodes ?? [];
  if (serendipity.length > 0) {
    const entries = buildSection(serendipity, 2);
    if (entries.length > 0) {
      parts.push(`### Serendipity\n${entries.join("\n")}`);
    }
  }

  if (parts.length === 0) return "";
  return `## What I Remember Right Now\n\n${parts.join("\n\n")}`;
}

function buildSection(nodes: ScoredNode[], maxItems: number): string[] {
  return nodes.slice(0, maxItems).map(formatNodeEntry);
}

/**
 * Assemble an injection block for mid-conversation memory flashes.
 * Uses the same per-node format as context-load (age + full content).
 */
export function assembleInjectionBlock(nodes: ScoredNode[]): string {
  if (nodes.length === 0) return "";
  return nodes
    .map((scored) => {
      if (isCapabilityNode(scored.node)) {
        const content = scored.node.content.replace(/^(?:skill|cli):\S+\n/, "");
        return `- [skill] ${content} → use skill_load to activate`;
      }
      if (scored.node.eventDate != null) {
        return formatUpcomingEntry(scored);
      }
      return formatNodeEntry(scored);
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Image resolution
// ---------------------------------------------------------------------------

/**
 * Load and optimize images for memory injection.
 * Iterates scored nodes (already sorted by score), resolves the first
 * image ref for each image-bearing node, and returns up to maxImages.
 */
export async function resolveInjectionImages(
  nodes: ScoredNode[],
  maxImages: number,
): Promise<Map<string, ResolvedImage>> {
  const log = getLogger("memory-graph");
  const result = new Map<string, ResolvedImage>();
  for (const scored of nodes) {
    if (result.size >= maxImages) break;
    const refs = scored.node.imageRefs;
    if (!refs || refs.length === 0) continue;

    try {
      const data = await loadImageRefData(refs[0]!);
      if (!data) continue;

      const optimized = optimizeImageForTransport(
        data.data.toString("base64"),
        data.mimeType,
      );

      result.set(scored.node.id, {
        base64Data: optimized.data,
        mediaType: optimized.mediaType,
        description: refs[0]!.description,
      });
    } catch (err) {
      log.warn(
        `Skipping image for node ${scored.node.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecent(node: MemoryNode): boolean {
  const dayMs = 1000 * 60 * 60 * 24;
  return Date.now() - node.created < 2 * dayMs;
}

function isVeryRecent(node: MemoryNode): boolean {
  const hourMs = 1000 * 60 * 60;
  return Date.now() - node.created < 4 * hourMs;
}
