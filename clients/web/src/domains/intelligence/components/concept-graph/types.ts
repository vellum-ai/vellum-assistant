import type { PositionedNode } from "@/domains/intelligence/components/constellation-layout";

/** Node taxonomy the renderer colors by. Unknown backend kinds fall to "other". */
export type ConceptNodeKind = "concept" | "skill" | "capability" | "other";

/** Edge taxonomy the renderer styles by. */
export type ConceptEdgeKind = "link" | "learned" | "other";

/**
 * A force-laid-out graph node in 3D. Satisfies {@link PositionedNode}
 * (id/x/y/radius); `z` is the depth axis the renderer rotates/projects through.
 */
export interface GraphLayoutNode extends PositionedNode {
  /** Depth coordinate (centered at 0); rotated + projected by the renderer. */
  z: number;
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
