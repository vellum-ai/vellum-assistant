import { EDGE_LEARNED_COLOR, EDGE_LINK_COLOR } from "./constants";
import type { GraphLayoutEdge, GraphLayoutNode } from "./types";

interface ConceptEdgesLayerProps {
  edges: GraphLayoutEdge[];
  nodeById: Map<string, GraphLayoutNode>;
  /** Hovered/selected node id — its incident edges are emphasized, the rest dimmed. */
  activeId: string | null;
}

/**
 * Renders concept-graph edges as SVG lines, clipped to each node's circle so
 * they meet the rim rather than the center. Learned associations render dashed
 * and warm; authored links render solid and neutral. When a node is focused,
 * only its incident edges stay bright.
 */
export function ConceptEdgesLayer({
  edges,
  nodeById,
  activeId,
}: ConceptEdgesLayerProps) {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
    >
      {edges.map((edge) => {
        const from = nodeById.get(edge.fromId);
        const to = nodeById.get(edge.toId);
        if (!from || !to) return null;

        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        // Clip each endpoint to the node's circle edge.
        const x1 = from.x + ux * from.radius;
        const y1 = from.y + uy * from.radius;
        const x2 = to.x - ux * to.radius;
        const y2 = to.y - uy * to.radius;

        const learned = edge.kind === "learned";
        const incident =
          activeId != null &&
          (edge.fromId === activeId || edge.toId === activeId);
        const faded = activeId != null && !incident;

        return (
          <line
            key={edge.id}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={learned ? EDGE_LEARNED_COLOR : EDGE_LINK_COLOR}
            strokeWidth={incident ? 2 : 1.25}
            strokeDasharray={learned ? "4 4" : undefined}
            opacity={faded ? 0.12 : incident ? 0.85 : learned ? 0.5 : 0.4}
            style={{ transition: "opacity 0.2s ease, stroke-width 0.2s ease" }}
          />
        );
      })}
    </svg>
  );
}
