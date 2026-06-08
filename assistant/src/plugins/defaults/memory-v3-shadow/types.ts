export type LeafPath = string; // dot- or slash-pathed taxonomy node
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

export interface LeafFrontmatter {
  path: LeafPath;
  in_core: boolean;
  /**
   * Optional stable identifier for the leaf, independent of its taxonomy path.
   * Older leaves predate this field and omit it, so it is optional.
   */
  id?: string;
}

export interface LeafNode {
  path: LeafPath;
  frontmatter: LeafFrontmatter;
  description: string;
  members: Slug[];
  domain: string;
}

export interface LeafTree {
  leaves: Map<LeafPath, LeafNode>;
  byPage: Map<Slug, LeafPath[]>;
}

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
 * Lane attribution recorded per selection. The section-lane pipeline writes the
 * lane literals (`"needle" | "dense" | "edge" | "carry-forward"`); the legacy
 * tree literals (`"l1+l2" | "core+l2"`) are retained until the tree pipeline is
 * deleted. PR 11 tightens this to the lane literals only. The DB column is
 * free-text, so widening here needs no migration.
 */
export type SelectionSource =
  | "l1+l2"
  | "core+l2"
  | "needle"
  | "dense"
  | "edge"
  | "carry-forward";
