import { Slug, WorkingSetEntry } from "./types.js";

export class WorkingSet {
  private entries = new Map<Slug, WorkingSetEntry>();

  recordSelection(slug: Slug, turn: number, pinned: boolean): void {
    const existing = this.entries.get(slug);
    this.entries.set(slug, {
      slug,
      selectedAtTurn: existing?.selectedAtTurn ?? turn,
      pinned: existing?.pinned || pinned,
      lastSeenTurn: turn,
    });
  }

  union(): Set<Slug> {
    return new Set(this.entries.keys());
  }

  size(): number {
    return this.entries.size;
  }

  // evict(...) — added in a later PR
}
