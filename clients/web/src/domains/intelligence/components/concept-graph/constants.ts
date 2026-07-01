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
