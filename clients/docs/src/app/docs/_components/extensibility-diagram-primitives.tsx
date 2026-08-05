import type { CSSProperties } from "react";

/**
 * Shared building blocks for the extensibility lifecycle diagrams (the Agent
 * Loop and the assistant lifecycle). Rendered as inline, theme-aware SVG (no
 * raster image, no external graph dependency) so they stay crisp and recolor
 * with the docs light/dark themes via the `--docs-*` CSS variables.
 */

export const hookEdge: CSSProperties = {
  stroke: "var(--docs-accent)",
  strokeWidth: 2,
  fill: "none",
};

export const controlEdge: CSSProperties = {
  stroke: "var(--docs-text-subtle)",
  strokeWidth: 1.5,
  fill: "none",
  strokeDasharray: "5 5",
};

const nodeBox: CSSProperties = {
  fill: "var(--docs-surface)",
  stroke: "var(--docs-border-strong)",
  strokeWidth: 1.5,
};

const nodeLabel: CSSProperties = {
  fill: "var(--docs-text)",
  fontWeight: 600,
  fontSize: 14,
};

export const hookLabel: CSSProperties = {
  fill: "var(--docs-accent-strong)",
  fontSize: 12.5,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

export const controlLabel: CSSProperties = {
  fill: "var(--docs-text-subtle)",
  fontSize: 12,
  fontStyle: "italic",
};

export const labelBg: CSSProperties = {
  fill: "var(--docs-bg)",
};

export const junctionDot: CSSProperties = { fill: "var(--docs-accent)" };

const arrowControlFill: CSSProperties = { fill: "var(--docs-text-subtle)" };

export function DiagramNode({
  cx,
  cy,
  label,
}: {
  cx: number;
  cy: number;
  label: string;
}) {
  return (
    <>
      <rect
        x={cx - 94}
        y={cy - 27}
        width={188}
        height={54}
        rx={11}
        style={nodeBox}
      />
      <text x={cx} y={cy + 5} textAnchor="middle" style={nodeLabel}>
        {label}
      </text>
    </>
  );
}

/**
 * Arrowhead markers for hook (accent) and control-flow (subtle) edges. IDs
 * are namespaced by `prefix` so multiple diagrams can render on the same page
 * without colliding on marker ids.
 */
export function DiagramArrowMarkers({ prefix }: { prefix: string }) {
  return (
    <defs>
      <marker
        id={`${prefix}-arrow-hook`}
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path d="M0 0 L10 5 L0 10 z" style={junctionDot} />
      </marker>
      <marker
        id={`${prefix}-arrow-control`}
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path d="M0 0 L10 5 L0 10 z" style={arrowControlFill} />
      </marker>
    </defs>
  );
}

export function DiagramLegend({
  showControl = true,
}: {
  showControl?: boolean;
}) {
  return (
    <figcaption className="mt-3 flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
      <span className="inline-flex items-center gap-2">
        <svg width="26" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="26" y2="4" style={hookEdge} />
        </svg>
        Hook (fires on this transition)
      </span>
      {showControl ? (
        <span className="inline-flex items-center gap-2">
          <svg width="26" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="26" y2="4" style={controlEdge} />
          </svg>
          Control flow
        </span>
      ) : null}
    </figcaption>
  );
}
