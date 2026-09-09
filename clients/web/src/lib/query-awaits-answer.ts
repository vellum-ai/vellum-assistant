/**
 * A query with no answer yet that may still get one.
 *
 * `isLoading` is pending AND fetching, which misses the offline case: the
 * default network mode parks an enabled fetch at `fetchStatus: "paused"`,
 * reporting neither a load nor an error, so a gap with the browser offline
 * reads as an answer. A disabled query sits at `"idle"` instead, and that one
 * is final: a gate that holds a query closed is not waiting on it.
 *
 * For any surface deciding whether it knows enough to commit to something a
 * later render would contradict.
 */
export function awaitsAnswer(query: {
  isPending: boolean;
  fetchStatus: "fetching" | "paused" | "idle";
}): boolean {
  return query.isPending && query.fetchStatus !== "idle";
}
