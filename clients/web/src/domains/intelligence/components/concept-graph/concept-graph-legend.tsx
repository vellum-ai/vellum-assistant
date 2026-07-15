import type { CSSProperties } from "react";

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
  /** When provided (both edge kinds present), the Link / Learned rows become
   * toggles that show/hide that edge kind; the `*Active` flags dim the row
   * while its kind is hidden. Omitted → static, non-interactive rows. */
  onToggleLink?: () => void;
  onToggleLearned?: () => void;
  linkActive?: boolean;
  learnedActive?: boolean;
}

/** Compact legend for node kinds and edge kinds present in the graph. */
export function ConceptGraphLegend({
  nodeKinds,
  coloredByTheme,
  hasLinks,
  hasLearned,
  onToggleLink,
  onToggleLearned,
  linkActive,
  learnedActive,
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
        <EdgeLegendRow
          swatchStyle={{ borderTop: `2px solid ${EDGE_LINK_COLOR}` }}
          label="Link"
          onToggle={onToggleLink}
          active={linkActive}
        />
      )}
      {hasLearned && (
        <EdgeLegendRow
          swatchStyle={{ borderTop: `2px dashed ${EDGE_LEARNED_COLOR}` }}
          label="Learned"
          onToggle={onToggleLearned}
          active={learnedActive}
        />
      )}
    </div>
  );
}

/** One edge-kind legend row: a line swatch + label. With `onToggle` it renders
 * as a button that shows/hides that edge kind (dimmed while its kind is hidden);
 * without one it's a static, non-interactive row that keeps the legend's look. */
function EdgeLegendRow({
  swatchStyle,
  label,
  onToggle,
  active,
}: {
  swatchStyle: CSSProperties;
  label: string;
  onToggle?: () => void;
  active?: boolean;
}) {
  const swatch = <span className="inline-block h-0 w-4" style={swatchStyle} />;
  const text = (
    <span className="text-[11px]" style={{ color: "var(--content-tertiary)" }}>
      {label}
    </span>
  );
  if (!onToggle) {
    return (
      <div className="flex items-center gap-2">
        {swatch}
        {text}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className="pointer-events-auto flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 transition-opacity"
      style={{ opacity: active === false ? 0.4 : 1 }}
    >
      {swatch}
      {text}
    </button>
  );
}
