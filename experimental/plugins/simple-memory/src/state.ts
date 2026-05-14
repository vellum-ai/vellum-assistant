/**
 * In-process store shared between hooks, tools, and the injector.
 *
 * Phase 0 keeps memory in process and persists to a single JSONL file
 * managed by the init/shutdown hooks. Real backing store lands later.
 *
 * The logger is stashed here at init time so the no-arg `onShutdown` hook
 * can still emit structured logs without re-receiving the runtime context.
 */

export interface MemoryEntry {
  readonly id: string;
  readonly conversationId: string;
  readonly text: string;
  /** Epoch milliseconds when the entry was written. */
  readonly createdAt: number;
}

import type { PluginLogger } from "@vellumai/plugin-api";

export interface PluginState {
  /** Absolute path to the JSONL file backing the in-memory store. */
  storePath: string;
  /** All entries, append-order. */
  entries: MemoryEntry[];
  /** Child logger handed to us by the harness at init time. */
  logger: PluginLogger;
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
    throw new Error(
      "simple-memory: state not initialized — was init() called?",
    );
  }
  return state;
}

/**
 * Regex search across every entry, regardless of conversation. The
 * pattern is applied with `RegExp.test` against each entry's text;
 * callers compile and case-flag it. Results are returned newest-first
 * (descending `createdAt`) and capped at `limit`.
 */
export function searchEntries(pattern: RegExp, limit: number): MemoryEntry[] {
  const all = requireState().entries;
  const matches: MemoryEntry[] = [];
  for (const entry of all) {
    // `test()` advances `lastIndex` on global/sticky regexes; the tool
    // never compiles with those flags, but reset defensively in case a
    // future caller does.
    pattern.lastIndex = 0;
    if (pattern.test(entry.text)) {
      matches.push(entry);
    }
  }
  matches.sort((a, b) => b.createdAt - a.createdAt);
  return matches.slice(0, limit);
}

export function appendEntry(entry: MemoryEntry): void {
  requireState().entries.push(entry);
}

export function newEntryId(): string {
  return `sm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
