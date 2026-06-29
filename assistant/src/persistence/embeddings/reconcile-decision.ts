/**
 * Pure decision logic for reconciling the committed Qdrant collection
 * dimension against the dimension reported by a live probe of the configured
 * embedding backend.
 *
 * No-thrash rationale: under `provider: "auto"` the reachable backend can flip
 * between a small local model (384) and a large managed model (3072) purely on
 * transient availability, so a per-boot mismatch must NOT trigger a destructive
 * recreate/migrate. Platform intent to change dimensions is expressed by setting
 * an explicit provider (a fill-only deployment default supplied in a later PR),
 * never inferred from which backend happened to answer the probe this boot.
 *
 * This module is intentionally dependency-free: it imports neither the config
 * loader, Qdrant, nor any embedding backend. It maps observed inputs to a
 * decision; the orchestrator performs the I/O.
 */
export type ReconcileAction =
  | { kind: "noop" }
  | { kind: "commit-fresh"; dim: number }
  | { kind: "migrate"; fromDim: number; toDim: number }
  | { kind: "defer-degraded"; reason: string };

export function decideEmbeddingReconcile(input: {
  committedDim: number | null;
  probeDim: number | null;
  configuredProvider: string;
}): ReconcileAction {
  const { committedDim, probeDim, configuredProvider } = input;

  // Never destroy or commit while the backend is down.
  if (probeDim == null) {
    return { kind: "defer-degraded", reason: "no reachable embedding backend" };
  }

  // Fresh install adopts the reachable backend's dimension.
  if (committedDim == null) {
    return { kind: "commit-fresh", dim: probeDim };
  }

  // Reachable backend matches the committed collection.
  if (committedDim === probeDim) {
    return { kind: "noop" };
  }

  // Under auto, stay committed — never thrash 384 <-> 3072 on transient
  // availability. A genuine upgrade is expressed by setting provider explicitly.
  if (configuredProvider === "auto") {
    return { kind: "noop" };
  }

  // Deliberate provider intent; probe already confirmed the backend is reachable.
  return { kind: "migrate", fromDim: committedDim, toDim: probeDim };
}
