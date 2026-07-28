import type { ConceptNodeKind } from "./types";

/** Node fill/stroke color per taxonomy kind. Values are the resolved hex of
 * Vellum brand tokens (canvas `fillStyle` can't read CSS `var()`), so nodes
 * read consistently across light/dark; labels use theme tokens.
 * - concept    → `--system-info-strong` (brand blue)
 * - skill      → `--feed-nudge-strong` (brand pink accent)
 * - capability → `--credits-accent` / `--feed-digest-strong` (brand teal)
 * - pending    → `--system-mid-strong` (warm amber, shared with learned
 *                edges — both mark not-yet-solidified structure); the dashed
 *                ring is the primary discriminator from cluster golds
 * - other      → `--content-quiet` / stone-500 (brand neutral) */
export const NODE_KIND_COLORS: Record<ConceptNodeKind, string> = {
  concept: "#467CC8",
  skill: "#DB4B77",
  capability: "#0E9B8B",
  pending: "#F1B21E",
  other: "#8D99A5",
};

/** Categorical fills for concept clusters/themes, indexed by the compact
 * cluster id from `detectClusters`. Ten hues derived from Vellum's brand
 * ramps/accent tokens (see `packages/design-library/src/tokens.css`), ordered
 * so adjacent cluster ids (0,1,2,…) contrast, and tuned bright enough to read
 * on the dark graph surface. These are data-viz *series* colors — semantic by
 * cluster, not by theme surface — and the canvas needs resolved hex (no
 * `var()`), so each entry is the literal value of the brand token named in the
 * trailing comment. Vellum has no ready-made categorical/series palette (its
 * accent hues are curated one-offs), so this brand-derived ramp lives here.
 * Callers index modulo the length; `NODE_KIND_COLORS` stays as the per-kind
 * fallback. No entry reuses the `skill`/`capability` hues from
 * `NODE_KIND_COLORS`: concepts are drawn from this palette but non-concept
 * nodes from `NODE_KIND_COLORS`, so a themed concept must stay distinguishable
 * from a skill/capability node if those ever render alongside concepts.
 *
 * TODO(design): confirm exact Vellum brand ramp — see
 * .private/plans/memory-viz-v2-spec.md open question */
export const CLUSTER_PALETTE: string[] = [
  "#467CC8", // system-info-strong — blue
  "#E86B40", // danger-600 / system-negative-hover — orange
  "#7A5AF5", // violet — fills a brand hue gap; distinct from node-kind colors
  "#22B8CF", // cyan — distinct from capability teal + skill pink
  "#3DB85E", // forest-500 — green
  "#E9C91A", // feed-thread-strong — yellow
  "#E83F5B", // velvet primary-base — brand red
  "#6ECF87", // forest-400 — mint
  "#F39B74", // danger-500 — peach
  "#F5C94E", // amber-500 — gold
];

export const NODE_KIND_LABELS: Record<ConceptNodeKind, string> = {
  concept: "Concept",
  skill: "Skill",
  capability: "Capability",
  pending: "Pending",
  other: "Other",
};

/** Authored/structural links use a neutral theme token; learned associations
 * use Vellum's warm accent (`--system-mid-strong` / amber-600) + dashes so the
 * two edge kinds read apart at a glance. The learned color is drawn on the
 * canvas, so it's the resolved hex rather than a `var()`. */
export const EDGE_LINK_COLOR = "var(--content-tertiary)";
export const EDGE_LEARNED_COLOR = "#F1B21E";
