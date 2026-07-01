/**
 * Canonical, backend-agnostic memory-graph topology contract.
 *
 * This is the DURABLE wire shape for "the assistant's memory as a graph": a set
 * of nodes (concepts / notes / entities) and the edges between them. It is
 * deliberately minimal and optional-rich so that ANY memory backend can map
 * onto it — the in-prod memory-v3 article/link graph today, and a swapped-in
 * backend (Cognee, Zep, …) tomorrow — without the route or the clients that
 * consume it having to change. The producer names itself via `backend`.
 *
 * Backends that cannot expose a graph return `{ supported: false }` with empty
 * arrays; consumers render a dedicated "not available on this backend" state
 * rather than treating it as an error (mirrors the `MEMORY_V2_DISABLED`
 * two-state pattern already used by the concept-page reads).
 */

import { z } from "zod";

export const MemoryGraphNodeSchema = z.object({
  /** Stable, backend-defined node id (memory-v3: the article slug). */
  id: z.string(),
  /** Human-readable display title. */
  label: z.string(),
  /** Optional short description / summary shown on hover. */
  summary: z.string().optional(),
  /**
   * Backend taxonomy tag for coloring/filtering (memory-v3: `concept` |
   * `skill` | `capability`). Free-form so backends can use their own kinds.
   */
  kind: z.string().optional(),
  /**
   * Relative importance / size hint for rendering (memory-v3: node degree).
   * Not normalized — consumers scale it for their own layout.
   */
  weight: z.number().optional(),
  /** Epoch ms the node was last updated, when the backend tracks it. */
  updatedAtMs: z.number().optional(),
});
export type MemoryGraphNode = z.infer<typeof MemoryGraphNodeSchema>;

export const MemoryGraphEdgeSchema = z.object({
  /** Source node id. */
  source: z.string(),
  /** Target node id. */
  target: z.string(),
  /**
   * Relationship kind for styling (memory-v3: `link` for authored links /
   * wikilinks, `learned` for behavioral co-selection associations).
   */
  kind: z.string().optional(),
  /** Optional strength in [0, 1] when the backend scores edges. */
  weight: z.number().optional(),
  /** Optional curated edge label (memory-v3: the `links:` description). */
  description: z.string().optional(),
  /** Whether the edge is directed. Undirected edges may render without arrows. */
  directed: z.boolean().optional(),
});
export type MemoryGraphEdge = z.infer<typeof MemoryGraphEdgeSchema>;

export const MemoryGraphSchema = z.object({
  /** Name of the memory backend that produced this graph; `null` if none. */
  backend: z.string().nullable(),
  /** Whether the active backend exposes a graph at all. */
  supported: z.boolean(),
  nodes: z.array(MemoryGraphNodeSchema),
  edges: z.array(MemoryGraphEdgeSchema),
  /** Set when the graph was capped and does not include every node/edge. */
  truncated: z.boolean().optional(),
});
export type MemoryGraph = z.infer<typeof MemoryGraphSchema>;
