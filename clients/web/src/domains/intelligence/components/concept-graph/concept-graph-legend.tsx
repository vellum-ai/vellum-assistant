import {
  EDGE_LEARNED_COLOR,
  EDGE_LINK_COLOR,
  NODE_KIND_COLORS,
  NODE_KIND_LABELS,
} from "./constants";
import type { ConceptNodeKind } from "./types";

interface ConceptGraphLegendProps {
  /** Node kinds actually present in the graph, in display order. */
  nodeKinds: ConceptNodeKind[];
  /** When true (concept-only graph), nodes are colored by cluster/theme, so a
   * lone kind swatch would be meaningless — show a caption instead. */
  coloredByTheme?: boolean;
  hasLinks: boolean;
  hasLearned: boolean;
}

/** Compact legend for node kinds and edge kinds present in the graph. */
export function ConceptGraphLegend({
  nodeKinds,
  coloredByTheme,
  hasLinks,
  hasLearned,
}: ConceptGraphLegendProps) {
  return (
    <div
      className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-1.5 rounded-lg px-3 py-2"
      style={{
        backgroundColor: "color-mix(in srgb, var(--surface-base) 78%, transparent)",
        border: "1px solid var(--border-base)",
      }}
    >
      {nodeKinds.map((kind) => (
        <div key={kind} className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: NODE_KIND_COLORS[kind] }}
          />
          <span
            className="text-[11px]"
            style={{ color: "var(--content-tertiary)" }}
          >
            {NODE_KIND_LABELS[kind]}
          </span>
        </div>
      ))}
      {coloredByTheme && (
        <span className="text-[11px]" style={{ color: "var(--content-tertiary)" }}>
          Colored by theme
        </span>
      )}
      {(nodeKinds.length > 0 || coloredByTheme) && (hasLinks || hasLearned) && (
        <div
          className="mt-0.5 border-t pt-1.5"
          style={{ borderColor: "var(--border-base)" }}
        />
      )}
      {hasLinks && (
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-0 w-4"
            style={{ borderTop: `2px solid ${EDGE_LINK_COLOR}` }}
          />
          <span
            className="text-[11px]"
            style={{ color: "var(--content-tertiary)" }}
          >
            Link
          </span>
        </div>
      )}
      {hasLearned && (
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-0 w-4"
            style={{ borderTop: `2px dashed ${EDGE_LEARNED_COLOR}` }}
          />
          <span
            className="text-[11px]"
            style={{ color: "var(--content-tertiary)" }}
          >
            Learned
          </span>
        </div>
      )}
    </div>
  );
}
