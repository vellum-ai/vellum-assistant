import { NODE_KIND_COLORS } from "./constants";
import type { GraphLayoutNode } from "./types";

interface ConceptNodeProps {
  node: GraphLayoutNode;
  /** The node is the hovered/selected focus. */
  active: boolean;
  /** A focus exists elsewhere and this node is outside its neighborhood. */
  dimmed: boolean;
  /** Whether to render the label (zoomed in, a hub, or in the active set). */
  showLabel: boolean;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}

/**
 * A single concept-graph node: a circle sized by degree and colored by kind,
 * with its label beneath. Positioned in virtual canvas space (the parent
 * applies the pan/zoom transform). Carries `data-constellation-node` so the
 * viewport treats a press on it as a node interaction, not a background pan.
 */
export function ConceptNode({
  node,
  active,
  dimmed,
  showLabel,
  onHover,
  onClick,
}: ConceptNodeProps) {
  const color = NODE_KIND_COLORS[node.kind];
  const diameter = node.radius * 2;

  return (
    <div
      className="absolute"
      style={{
        left: node.x,
        top: node.y,
        transform: "translate(-50%, -50%)",
        opacity: dimmed ? 0.28 : 1,
        transition: "opacity 0.2s ease",
        zIndex: active ? 3 : 1,
      }}
    >
      <button
        type="button"
        data-constellation-node
        aria-label={node.label}
        onPointerEnter={() => onHover(node.id)}
        onPointerLeave={() => onHover(null)}
        onClick={(event) => {
          event.stopPropagation();
          onClick(node.id);
        }}
        className="block cursor-pointer rounded-full"
        style={{
          width: diameter,
          height: diameter,
          backgroundColor: `color-mix(in srgb, ${color} ${active ? "85%" : "60%"}, transparent)`,
          border: `${active ? 2.5 : 1.5}px solid ${color}`,
          boxShadow: active
            ? `0 0 0 4px color-mix(in srgb, ${color} 22%, transparent)`
            : "none",
          transition: "background-color 0.2s ease, border-width 0.2s ease",
        }}
      />
      {showLabel ? (
        <span
          className="pointer-events-none absolute left-1/2 top-full mt-1 max-w-[120px] -translate-x-1/2 truncate text-center text-[11px] leading-tight"
          style={{
            color: "var(--content-default)",
            fontWeight: active ? 600 : 400,
            opacity: dimmed ? 0.4 : 0.9,
          }}
          title={node.label}
        >
          {node.label}
        </span>
      ) : null}
    </div>
  );
}
