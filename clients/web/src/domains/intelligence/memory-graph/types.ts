/**
 * Client mirror of the backend-agnostic memory-graph contract
 * (`GET /v1/assistants/{id}/memory-graph`). Kept as hand-written domain types
 * so the graph components don't depend on generated SDK type names; the query
 * layer maps the SDK response onto these.
 */

export interface MemoryGraphNode {
  id: string;
  label: string;
  summary?: string;
  /** Backend taxonomy tag: memory-v3 emits "concept" | "skill" | "capability". */
  kind?: string;
  /** Relative importance / size hint (memory-v3: node degree). */
  weight?: number;
  updatedAtMs?: number;
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
  /** memory-v3: "link" (authored/structural) | "learned" (co-selection). */
  kind?: string;
  weight?: number;
  description?: string;
  directed?: boolean;
}

export interface MemoryGraph {
  backend: string | null;
  supported: boolean;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  truncated?: boolean;
}

/**
 * Two-state result. `unsupported` is a success-shaped outcome (the active
 * memory backend exposes no graph) that the UI renders as a dedicated empty
 * state, rather than an error. A supported-but-empty graph is `ready` with zero
 * nodes and gets its own "no concepts yet" copy.
 */
export type MemoryGraphResult =
  | { kind: "ready"; graph: MemoryGraph }
  | { kind: "unsupported" };
