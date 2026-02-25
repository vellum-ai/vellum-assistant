/**
 * Shared graph utilities for swarm DAG operations.
 */

export interface GraphNode {
  id: string;
  dependencies: string[];
}

/**
 * Detect cycles in a directed graph using Kahn's algorithm.
 * Returns the IDs of nodes involved in cycles, or null if the graph is acyclic.
 */
export function detectCycles(nodes: GraphNode[]): string[] | null {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adj.set(node.id, []);
  }

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      if (adj.has(dep)) {
        adj.get(dep)!.push(node.id);
        inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    processed++;
    for (const neighbor of adj.get(current)!) {
      const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (processed < nodes.length) {
    return nodes
      .filter((n) => (inDegree.get(n.id) ?? 0) > 0)
      .map((n) => n.id);
  }

  return null;
}
