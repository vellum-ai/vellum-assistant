/**
 * Domain names for the backend-agnostic memory-graph contract
 * (`GET /v1/assistants/{id}/memory-graph`). Derived from the generated SDK
 * response types so they can't drift from the wire; the graph components
 * import these instead of coupling to generated SDK type names. Field
 * semantics are documented on the source-of-truth zod schemas in
 * `assistant/src/plugins/defaults/memory/graph-topology/types.ts`.
 */

import type {
  MemorygraphGetResponse,
  MemorygraphnodeGetResponse,
} from "@/generated/daemon/types.gen";

export type MemoryGraph = MemorygraphGetResponse;
export type MemoryGraphNode = MemoryGraph["nodes"][number];
export type MemoryGraphEdge = MemoryGraph["edges"][number];

/**
 * Two-state result. `unsupported` is a success-shaped outcome (the active
 * memory backend exposes no graph) that the UI renders as a dedicated empty
 * state, rather than an error. A supported-but-empty graph is `ready` with zero
 * nodes and gets its own "no concepts yet" copy.
 */
export type MemoryGraphResult =
  | { kind: "ready"; graph: MemoryGraph }
  | { kind: "unsupported" };

/** Detail for a single node — the concept's rendered markdown, fetched on open. */
export type MemoryGraphNodeDetail = MemorygraphnodeGetResponse;
