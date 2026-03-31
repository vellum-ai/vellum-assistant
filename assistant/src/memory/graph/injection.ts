// ---------------------------------------------------------------------------
// Memory Graph — Context assembly and injection tracking
// ---------------------------------------------------------------------------

import type { MemoryNode, ScoredNode } from "./types.js";

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

interface AssemblyOptions {
  // No token cap — the retriever's node count (30-40) is the only limit.
  // The context block includes full node content.
}

/**
 * Compress a node's content to 1-2 sentences for the context block.
 * The full prose lives in the node — the context block is a highlight reel.
 */
function compressContent(content: string, maxChars: number = 200): string {
  // Take up to the first two sentences
  const sentences = content.match(/[^.!?]+[.!?]+/g);
  if (!sentences) return content.slice(0, maxChars);

  let result = sentences[0].trim();
  if (sentences.length > 1 && result.length + sentences[1].length < maxChars) {
    result += " " + sentences[1].trim();
  }

  if (result.length > maxChars) {
    return result.slice(0, maxChars - 1) + "…";
  }
  return result;
}

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

/** Format a single node for the context block. */
function formatNodeEntry(scored: ScoredNode): string {
  const node = scored.node;
  const age = relativeAge(node.created);
  return `- (${age}) ${node.content}`;
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
  options?: AssemblyOptions & { serendipityNodes?: ScoredNode[] },
): string {
  // Partition nodes into sections
  const rightNow: ScoredNode[] = [];
  const threads: ScoredNode[] = [];
  const triggered: ScoredNode[] = [];
  const onMyMind: ScoredNode[] = [];

  for (const scored of nodes) {
    const node = scored.node;

    if (scored.scoreBreakdown.triggerBoost > 0) {
      triggered.push(scored);
    } else if (node.type === "prospective") {
      threads.push(scored);
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
  return nodes.map(formatNodeEntry).join("\n");
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
