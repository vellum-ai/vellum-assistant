/**
 * Deterministic community detection for the memory concept graph.
 *
 * Pure and dependency-free: runs synchronous label propagation over an
 * undirected view of the graph — NO RNG (Math.random is forbidden in layout
 * code) and NO Date.now(), so identical input always yields an identical map.
 * Cluster ids are renumbered into a compact 0..k-1 range so a caller can index
 * a color palette by id directly.
 */

const PASSES = 8;

/**
 * Partition graph nodes into clusters via deterministic label propagation.
 *
 * Each node starts in its own cluster and, over a fixed number of passes,
 * adopts the most frequent label among its neighbors (ties broken by the lowest
 * label id for determinism). Disconnected nodes (degree 0) keep their initial,
 * unique label and therefore each land in their own cluster.
 *
 * @returns A map from every node id to a compact cluster id in `0..k-1`,
 *   assigned in order of first appearance in `nodes`.
 */
export function detectClusters(
  nodes: readonly { id: string }[],
  edges: readonly { fromId: string; toId: string }[],
): Map<string, number> {
  const n = nodes.length;
  if (n === 0) {return new Map();}

  const indexById = new Map<string, number>();
  nodes.forEach((node, i) => indexById.set(node.id, i));

  // Undirected neighbor adjacency; drop self-loops and edges to unknown nodes.
  const neighbors: number[][] = nodes.map(() => []);
  for (const edge of edges) {
    const a = indexById.get(edge.fromId);
    const b = indexById.get(edge.toId);
    if (a === undefined || b === undefined || a === b) {continue;}
    neighbors[a].push(b);
    neighbors[b].push(a);
  }

  // Each node begins in its own cluster (label = its stable array index).
  const labels = nodes.map((_, i) => i);

  for (let pass = 0; pass < PASSES; pass++) {
    for (let i = 0; i < n; i++) {
      const adjacent = neighbors[i];
      if (adjacent.length === 0) {continue;}

      // Tally neighbor labels, then take the most frequent — lowest label wins
      // ties so the outcome never depends on iteration/insertion order.
      const counts = new Map<number, number>();
      for (const j of adjacent) {
        counts.set(labels[j], (counts.get(labels[j]) ?? 0) + 1);
      }
      let bestLabel = labels[i];
      let bestCount = -1;
      for (const [label, count] of counts) {
        if (count > bestCount || (count === bestCount && label < bestLabel)) {
          bestLabel = label;
          bestCount = count;
        }
      }
      labels[i] = bestLabel;
    }
  }

  // Renumber the surviving labels into a dense 0..k-1 range, in order of first
  // appearance, so ids stay small and stable for a palette to index.
  const compactByLabel = new Map<number, number>();
  const clusterById = new Map<string, number>();
  nodes.forEach((node, i) => {
    const label = labels[i];
    let compact = compactByLabel.get(label);
    if (compact === undefined) {
      compact = compactByLabel.size;
      compactByLabel.set(label, compact);
    }
    clusterById.set(node.id, compact);
  });

  return clusterById;
}
