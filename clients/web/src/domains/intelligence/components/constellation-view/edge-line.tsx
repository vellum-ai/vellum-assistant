
import { clipEdgeToNodes, type EdgeLine, type TreeNode } from "@/domains/intelligence/components/constellation-layout";

export interface EdgesLayerProps {
  edges: EdgeLine[];
  nodeById: Map<string, TreeNode>;
  visible: boolean;
}

/**
 * Renders all constellation edges as SVG lines. Much simpler than the previous
 * rotated-div approach — SVG `<line>` takes (x1, y1, x2, y2) directly.
 */
export function EdgesLayer({ edges, nodeById, visible }: EdgesLayerProps) {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
    >
      {edges.map((edge) => {
        const from = nodeById.get(edge.fromId);
        const to = nodeById.get(edge.toId);
        if (!from || !to) return null;
        const { x1, y1, x2, y2 } = clipEdgeToNodes(from, to);
        return (
          <line
            key={edge.id}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={edge.color}
            strokeWidth={1.5}
            opacity={visible ? 0.45 : 0}
            style={{ transition: "opacity 0.4s ease" }}
          />
        );
      })}
    </svg>
  );
}
