import type { ConceptNodeKind } from "./types";

/** Node fill/stroke color per taxonomy kind. Hex (like the skills category
 * palette) so nodes read consistently across light/dark; labels use theme
 * tokens. */
export const NODE_KIND_COLORS: Record<ConceptNodeKind, string> = {
  concept: "#5B8DEF",
  skill: "#A665C9",
  capability: "#0E9B8B",
  other: "#8D99A5",
};

/** Categorical fills for concept clusters/themes, indexed by the compact
 * cluster id from `detectClusters`. Ten distinct hues, ordered so adjacent
 * cluster ids (0,1,2,…) contrast strongly, tuned bright enough to read on the
 * dark graph surface. These are data-viz *series* colors — semantic by cluster,
 * not by theme surface — so raw hex is correct here (see STYLE_GUIDE "Color →
 * When raw hex is acceptable" and the `BAR_CHART_PALETTE` precedent). Callers
 * index modulo the length; `NODE_KIND_COLORS` stays as the per-kind fallback. */
export const CLUSTER_PALETTE: string[] = [
  "#5B8DEF", // blue
  "#FB923C", // orange
  "#2DD4BF", // teal
  "#F472B6", // pink
  "#A3E635", // lime
  "#C084FC", // violet
  "#FACC15", // yellow
  "#38BDF8", // sky
  "#F87171", // red
  "#4ADE80", // green
];

export const NODE_KIND_LABELS: Record<ConceptNodeKind, string> = {
  concept: "Concept",
  skill: "Skill",
  capability: "Capability",
  other: "Other",
};

/** Authored/structural links use a neutral theme token; learned associations
 * use a warm accent + dashes so the two edge kinds read apart at a glance. */
export const EDGE_LINK_COLOR = "var(--content-tertiary)";
export const EDGE_LEARNED_COLOR = "#E9A23B";
