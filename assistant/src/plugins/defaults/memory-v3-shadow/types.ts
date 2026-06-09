export type Slug = string;

/**
 * Injection-block id for the v3 live `<memory>` block. Shared between the
 * producer (the v3 injector in `shadow-plugin.ts`) and the v2-suppression
 * consumer (`conversation-runtime-assembly.ts`), which keys off this id to
 * detect that v3 actually produced a block this turn. Keeping it in one place
 * makes a rename a compile error on both sides instead of a silent
 * suppression bypass.
 */
export const MEMORY_V3_BLOCK_ID = "memory-v3" as const;

/**
 * A single section of a page: the lead (text before the first `## heading`,
 * ordinal 0) or a heading-delimited block. Over-long sections are split into
 * multiple ordered `Section`s, each with its own consecutive `ordinal`, so each
 * fits a typical embedding window. `text` is prefixed with a
 * `${lastSlugSegment} — ${title}` head line for lexical/dense matching.
 */
export interface Section {
  article: Slug;
  title: string;
  text: string;
  ordinal: number;
}

/**
 * A flat, deterministic index of every page's sections plus an article→section
 * lookup. `byArticle` maps each article slug to the indices (into `sections`)
 * of that article's sections, in order.
 */
export interface SectionIndex {
  sections: Section[];
  byArticle: Map<Slug, number[]>;
}

/** A page selected from the candidate pool, with whether the turn centers on it. */
export interface SelectedPage {
  slug: Slug;
  pinned: boolean;
}

export interface WorkingSetEntry {
  slug: Slug;
  selectedAtTurn: number;
  pinned: boolean;
  lastSeenTurn: number;
}

export interface MemoryRoutingTurn {
  conversationId: string;
  turnNumber: number;
  currentMessage: string;
  recentContext: string;
  /**
   * Optional situational signal — the current date plus the live NOW.md
   * scratchpad — so a leaf or page can be routed/selected on a date or
   * live-state cue the message itself never names (e.g. a person whose
   * anniversary is today). Omitted when unavailable; the router and selector
   * render nothing for an undefined value.
   */
  situationalContext?: string;
}

/**
 * Canonical ordered list of the lane sources recorded per selection. The
 * {@link SelectionSource} type is derived from this so a new lane is added in
 * exactly one place and the runtime list (used for telemetry roll-ups and
 * source validation) can never drift from the type.
 *
 * `core` / `hot` are the stable-prefix lanes (curated core set, frecency hot
 * set); `needle` / `dense` / `edge` are the per-turn finder lanes.
 * `carry-forward` is no longer emitted (the working-set carry was removed from
 * orchestration); it stays listed so historical rows still aggregate.
 *
 * The `memory_v3_selections.source` column is free-text, so tightening this set
 * needs no migration: any historical rows with older labels still read back
 * fine via the permissive `z.string()` row schema.
 */
export const SELECTION_SOURCES = [
  "core",
  "hot",
  "needle",
  "dense",
  "edge",
  "carry-forward",
] as const;

export type SelectionSource = (typeof SELECTION_SOURCES)[number];

/**
 * The per-turn finder lanes — the strict subset of {@link SelectionSource} a
 * finder candidate can be tagged with at pool-build time. (`core` / `hot` are
 * assigned by stable-prefix membership, not by a finder; `carry-forward` is a
 * historical-rows-only label.) Defined via `Exclude` so it can never drift from
 * {@link SELECTION_SOURCES}: adding a finder lane there widens this
 * automatically.
 */
export type FinderLane = Exclude<
  SelectionSource,
  "core" | "hot" | "carry-forward"
>;
