/**
 * Generic optimistic cancel / restore / retire lifecycle for entry-map stores.
 *
 * The acp-run and background-task stores share a byte-parallel trio:
 *
 * - **cancel** — optimistically mark an active entry "cancelling/cancelled"
 *   (user pressed Stop). No-op for unknown or already-terminal entries so a
 *   finished entry is never regressed.
 * - **restore** — roll back that optimistic cancel when the cancel request
 *   fails, reverting to the prior status. No-op unless the entry is still in
 *   the optimistic cancelled state (and, where applicable, not yet settled by
 *   a real terminal), so a landed terminal is never regressed back to active.
 * - **retire** — mark active entries that an authoritative daemon snapshot no
 *   longer reports as cancelled (the daemon restarted and lost the subprocess
 *   before persisting a terminal row, so no event will ever settle them).
 *
 * These pure transforms are parameterized by the status values each store uses
 * for the optimistic transition and by its terminal-state predicate. Each store
 * wraps them in its own zustand setters; entry shapes stay domain-specific.
 */

/**
 * Per-store configuration for the optimistic lifecycle transforms.
 *
 * @typeParam Entry - the store's entry record.
 * @typeParam Status - the store's status union.
 */
export interface OptimisticLifecycleConfig<Entry, Status> {
  /** Read an entry's current status. */
  getStatus: (entry: Entry) => Status;
  /** Whether a status is active (non-terminal) and thus cancelable. */
  isActive: (status: Status) => boolean;
  /** The status an optimistic cancel transitions an active entry to. */
  cancelledStatus: Status;
  /**
   * Apply the cancel mutation, producing the optimistically-cancelled entry.
   * Stores set their own terminal fields here (e.g. `completedAt`).
   */
  applyCancel: (entry: Entry) => Entry;
  /**
   * Apply the restore mutation, reverting an optimistically-cancelled entry to
   * `prev`. Stores clear their own terminal fields here.
   */
  applyRestore: (entry: Entry, prev: Status) => Entry;
  /**
   * Apply the retire mutation, settling a still-active entry the daemon no
   * longer reports. Stores set their own terminal fields here (e.g. a
   * `daemon_restarted` stop reason).
   */
  applyRetire: (entry: Entry) => Entry;
  /**
   * Whether an entry already settled by a real terminal (so restore must not
   * revive it) — even one that preserved the cancelled status via a racing
   * failed completion. Defaults to always-false: stores whose optimistic cancel
   * is indistinguishable from a settled terminal rely solely on the status
   * guard.
   */
  isSettled?: (entry: Entry) => boolean;
}

/**
 * Optimistically cancel an active entry. Returns the cancelled entry, or `null`
 * when there is no change (unknown or already-terminal entry).
 */
export function optimisticCancel<Entry, Status>(
  entry: Entry | undefined,
  config: OptimisticLifecycleConfig<Entry, Status>,
): Entry | null {
  if (!entry || !config.isActive(config.getStatus(entry))) return null;
  return config.applyCancel(entry);
}

/**
 * Roll back an optimistic cancel, reverting to `prev`. Returns the restored
 * entry, or `null` when there is no change — unknown entry, not in the
 * optimistic cancelled state, or already settled by a real terminal.
 */
export function optimisticRestore<Entry, Status>(
  entry: Entry | undefined,
  prev: Status,
  config: OptimisticLifecycleConfig<Entry, Status>,
): Entry | null {
  if (
    !entry ||
    config.getStatus(entry) !== config.cancelledStatus ||
    config.isSettled?.(entry)
  ) {
    return null;
  }
  return config.applyRestore(entry, prev);
}

/**
 * Retire an active entry the daemon snapshot dropped. Returns the retired
 * entry, or `null` when there is no change (already-terminal entry). Callers
 * own the selection of WHICH entries to feed in (e.g. an id list, or filtering
 * `byId` against an active/known snapshot).
 */
export function optimisticRetire<Entry, Status>(
  entry: Entry | undefined,
  config: OptimisticLifecycleConfig<Entry, Status>,
): Entry | null {
  if (!entry || !config.isActive(config.getStatus(entry))) return null;
  return config.applyRetire(entry);
}
