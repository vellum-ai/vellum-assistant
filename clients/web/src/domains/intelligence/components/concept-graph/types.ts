import type { PositionedNode } from "@/domains/intelligence/components/constellation-layout";

/** Node taxonomy the renderer colors by. Unknown backend kinds fall to "other". */
export type ConceptNodeKind = "concept" | "skill" | "capability" | "other";

/** Edge taxonomy the renderer styles by. */
export type ConceptEdgeKind = "link" | "learned" | "other";

/**
 * A force-laid-out graph node. Satisfies {@link PositionedNode} (id/x/y/radius)
 * so it plugs straight into `useConstellationViewport` and `computeFit`.
 */
export interface GraphLayoutNode extends PositionedNode {
  label: string;
  kind: ConceptNodeKind;
  summary?: string;
  /** Number of incident edges — drives node size and hover neighborhoods. */
  degree: number;
  updatedAtMs?: number;
}

export interface GraphLayoutEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: ConceptEdgeKind;
  description?: string;
  directed: boolean;
}

export interface GraphLayout {
  nodes: GraphLayoutNode[];
  edges: GraphLayoutEdge[];
}
