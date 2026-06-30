/**
 * Shared history-merge primitives for the background-process stores
 * (`acp-run-store`, `background-task-store`).
 *
 * Both stores reconcile a live, streaming entry map against an authoritative
 * history snapshot with the same two rules:
 *
 *   1. Terminal-history-wins: a terminal history status overrides a live
 *      non-terminal one, so a finished process never stays stuck "running".
 *   2. Don't-regress-a-live-terminal: a live terminal status is never pushed
 *      back to a non-terminal history status (stale snapshot can't revive it).
 *
 * Each store keeps its own domain entry type and status union; these helpers
 * are parameterized by an `isTerminal` predicate (or, equivalently, by the
 * store's `isActive` predicate) and a domain merge callback, so no shared entry
 * type is introduced.
 */

/**
 * Pick the merged status under the terminal-history-wins /
 * don't-regress-a-live-terminal rule.
 *
 * `isActive(status)` reports whether a status is non-terminal (active). The
 * incoming (history) status wins unless the live entry is already terminal and
 * the incoming one is not — in which case the live terminal status is kept.
 *
 * Equivalent to each store's original inline expression:
 *   `isActive(existing) || !isActive(incoming) ? incoming : existing`.
 */
export function mergeTerminalStatus<S>(
  existingStatus: S,
  incomingStatus: S,
  isActive: (status: S) => boolean,
): S {
  return isActive(existingStatus) || !isActive(incomingStatus)
    ? incomingStatus
    : existingStatus;
}

/**
 * Idempotent merge of history `entries` into a byId/orderedIds pair.
 *
 * For each entry: if an entry with the same id already exists, it is replaced
 * by `merge(existing, incoming)`; otherwise the incoming entry is inserted and
 * its id appended to `orderedIds`. Ordering of pre-existing ids is preserved and
 * new ids are appended in `entries` order.
 *
 * Reference stability matches the stores' hand-rolled loops: fresh `byId` and
 * `orderedIds` containers are always returned (callers pass these straight into
 * `set`). The `idOf` extractor lets each store key on its own id field
 * (`acpSessionId` vs `id`).
 *
 * @returns the next `byId` map and `orderedIds` array.
 */
export function seedEntriesFromHistory<E>(params: {
  entries: E[];
  byId: Record<string, E>;
  orderedIds: string[];
  idOf: (entry: E) => string;
  merge: (existing: E, incoming: E) => E;
}): { byId: Record<string, E>; orderedIds: string[] } {
  const { entries, idOf, merge } = params;
  const byId = { ...params.byId };
  const orderedIds = [...params.orderedIds];

  for (const entry of entries) {
    const id = idOf(entry);
    const existing = byId[id];
    byId[id] = existing ? merge(existing, entry) : entry;
    if (!orderedIds.includes(id)) orderedIds.push(id);
  }

  return { byId, orderedIds };
}
