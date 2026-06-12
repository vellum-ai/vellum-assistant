// ---------------------------------------------------------------------------
// Memory retrospective — fork-boundary detection.
// ---------------------------------------------------------------------------
//
// Shared between the retrospective job (scoping prior-`remember` dedup to the
// post-fork tail) and the startup orphan sweep (deciding whether a fork-kind
// retrospective row produced any post-fork output worth preserving as the
// next run's dedup baseline). Lives in its own module so the sweep doesn't
// have to import the job handler's full dependency graph.

/**
 * Locate the boundary timestamp between a fork-kind retrospective's copied
 * prefix and its post-fork tail. Scans from the end for the last message
 * whose metadata carries a `forkSourceMessageId` stamp (the last copied
 * source message); its `createdAt` is the boundary. The stamp's value may
 * point at any ancestor when the source was itself a fork
 * (`cloneForkMessageMetadata` preserves pre-existing values), so we only
 * check for presence, not equality. Returns `null` only if no copied
 * messages remain (corrupted fork metadata or empty fork — caller logs +
 * degrades).
 */
export function findForkBoundaryCreatedAt(
  forkMessages: Array<{
    createdAt: number;
    metadata: string | null;
  }>,
): number | null {
  for (let i = forkMessages.length - 1; i >= 0; i--) {
    const row = forkMessages[i]!;
    if (!row.metadata) continue;
    try {
      const parsed = JSON.parse(row.metadata) as {
        forkSourceMessageId?: unknown;
      };
      if (typeof parsed.forkSourceMessageId === "string") {
        return row.createdAt;
      }
    } catch {
      continue;
    }
  }
  return null;
}
