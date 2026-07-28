// ---------------------------------------------------------------------------
// Memory Graph — injection tracking
//
// `ConversationGraphMemory` keeps a tracker per conversation on every tier;
// the v1 read engine (`../v1/graph/`) consumes it during retrieval.
// ---------------------------------------------------------------------------

import type { ScoredNode } from "./types.js";

export interface InjectionLogEntry {
  nodeId: string;
  turn: number;
}

export interface InContextTrackerSnapshot {
  inContext: string[];
  log: InjectionLogEntry[];
  currentTurn: number;
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

  /** Serialize tracker state for persistence across eviction. */
  toJSON(): InContextTrackerSnapshot {
    return {
      inContext: [...this.inContext],
      log: [...this.log],
      currentTurn: this.currentTurn,
    };
  }

  /** Restore tracker state from a persisted snapshot. Replaces current state. */
  restoreFrom(snapshot: InContextTrackerSnapshot): void {
    this.inContext = new Set(snapshot.inContext);
    this.log = [...snapshot.log];
    this.currentTurn = snapshot.currentTurn;
  }
}
