/**
 * In-process store shared between hooks, tools, and the injector.
 *
 * Phase 0 keeps memory in process and persists to a single JSONL file
 * managed by the init/shutdown hooks. Real backing store lands later.
 */

export interface MemoryEntry {
  readonly id: string;
  readonly conversationId: string;
  readonly text: string;
  /** Epoch milliseconds when the entry was written. */
  readonly createdAt: number;
}

export interface PluginState {
  /** Absolute path to the JSONL file backing the in-memory store. */
  storePath: string;
  /** All entries, append-order. */
  entries: MemoryEntry[];
}

let state: PluginState | null = null;

export function setState(next: PluginState): void {
  state = next;
}

export function clearState(): void {
  state = null;
}

export function requireState(): PluginState {
  if (state === null) {
    throw new Error("simple-memory: state not initialized — was init() called?");
  }
  return state;
}

export function entriesFor(conversationId: string): MemoryEntry[] {
  return requireState().entries.filter((e) => e.conversationId === conversationId);
}

export function appendEntry(entry: MemoryEntry): void {
  requireState().entries.push(entry);
}

export function newEntryId(): string {
  return `sm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
