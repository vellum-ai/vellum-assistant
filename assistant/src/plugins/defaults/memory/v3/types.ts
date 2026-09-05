export type Slug = string;

/**
 * Injection-block id for the v3 live `<memory>` block. Shared between the
 * producer (the v3 injector in `injector.ts`) and the v2-suppression
 * consumer (`conversation-runtime-assembly.ts`), which keys off this id to
 * detect that v3 actually produced a block this turn. Keeping it in one place
 * makes a rename a compile error on both sides instead of a silent
 * suppression bypass.
 */
export const MEMORY_V3_BLOCK_ID = "memory-v3" as const;

/**
 * `meta` key under which the v3 sections block carries its attachment-commit
 * callback. The injector defers its section-store write (and the prune-valve
 * schedule) into this callback; runtime assembly invokes it only when the
 * turn's tail is a user message, the same gate as metadata capture, so a
 * block that silently fails to attach never claims its sections in the dedup
 * store. Shared between the producer (`injector.ts`) and the consumer
 * (`conversation-runtime-assembly.ts`) so a rename is a compile error on both
 * sides instead of a silent never-commit.
 */
export const MEMORY_V3_COMMIT_META_KEY = "memoryV3Commit" as const;

/**
 * Injection-block id for the v3 per-turn `<memory_pointer>` block: the list
 * of this turn's selected sections that are already resident in history.
 * Distinct from {@link MEMORY_V3_BLOCK_ID}: the pointer never participates in
 * v2 suppression, is never persisted, and is stripped from every user message
 * at the start of each turn before a fresh one is spliced onto the tail.
 */
export const MEMORY_V3_POINTER_BLOCK_ID = "memory-v3-pointer" as const;

/**
 * A single section of a page: the lead (text before the first `## heading`,
 * ordinal 0) or a heading-delimited block. Over-long sections are split into
 * multiple ordered `Section`s, each with its own consecutive `ordinal`, so each
 * fits a typical embedding window. `text` is prefixed with a
 * `${lastSlugSegment} — ${title}` head line for lexical/dense matching.
 *
 * `titleOrdinal` is this section's 0-based index among the article's sections
 * that share its title: a split heading's later chunks and a repeated heading
 * both count up. Absent means 0 (the first, and usually only, section under
 * that title). It feeds {@link sectionKey}; `ordinal` alone cannot, because
 * ordinals shift whenever consolidation adds or removes a section above.
 */
export interface Section {
  article: Slug;
  title: string;
  text: string;
  ordinal: number;
  titleOrdinal?: number;
}

/**
 * The stable identity of a section within its page, used as the section
 * store's `section_key` and carried in the injected header
 * (`# memory/concepts/<slug>.md § <key>`): the lead is `""`, a heading
 * section is its trimmed title, and the second and later sections sharing a
 * title (a chunked or repeated heading) append `#<titleOrdinal>`. Keys are
 * stable across consolidation edits that shift ordinals.
 */
export function sectionKey(section: Section): string {
  const title = section.title.trim();
  return section.titleOrdinal ? `${title}#${section.titleOrdinal}` : title;
}

/** The section title a {@link sectionKey} names: the key minus the `#<n>`
 *  suffix a chunked or repeated heading carries (`""` for the lead). */
export function sectionKeyTitle(key: string): string {
  return key.replace(/#\d+$/, "");
}

/** One injected section's identity in the section store: page slug plus
 *  {@link sectionKey} (`""` for the lead or for capability content). */
export interface SectionRef {
  slug: Slug;
  key: string;
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

/** A page selected from the candidate pool. */
export interface SelectedPage {
  slug: Slug;
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
  /**
   * Tail of the assistant's previous reply (the message before
   * `currentMessage`), fed to the reply-query finder pass as its OWN needle +
   * dense queries — never concatenated onto `currentMessage`, which would
   * average two speakers' retrieval intents into a vector that matches
   * neither. The assistant's prose carries the threads it is actively
   * developing, which the user's next message often references without
   * naming. Omitted on a conversation's first turn (no prior reply) or when
   * the reply lane is disabled.
   */
  previousAssistantMessage?: string;
}

/**
 * Canonical ordered list of the lane sources recorded per selection. The
 * {@link SelectionSource} type is derived from this so a new lane is added in
 * exactly one place and the runtime list (used for telemetry roll-ups and
 * source validation) can never drift from the type.
 *
 * `core` / `hot` / `fresh` are the stable-prefix lanes (curated core set,
 * frecency hot set, modification-recency fresh set); `needle` / `dense` /
 * `edge` are the per-turn finder lanes over the user's message; `reply` marks
 * finder candidates first surfaced by the reply-query pass (needle + dense
 * re-run over the assistant's previous message); `span` marks candidates first
 * surfaced by the span-query pass (dense re-run over the current message's
 * clause chunks as separate queries); `learned` marks candidates
 * surfaced by the co-selection NPMI association graph; `entity` marks
 * candidates surfaced because the message named an entity that titles a section
 * heading (the heading-anchored entity lane).
 *
 * The `memory_v3_selections.source` column is free-text, so tightening this set
 * needs no migration: any historical rows with retired labels (e.g. the old
 * per-turn carry source) still read back fine via the permissive `z.string()`
 * row schema — they just don't aggregate into a named bucket.
 */
export const SELECTION_SOURCES = [
  "core",
  "hot",
  "fresh",
  "needle",
  "dense",
  "edge",
  "reply",
  "span",
  "learned",
  "entity",
] as const;

export type SelectionSource = (typeof SELECTION_SOURCES)[number];

/**
 * The per-turn finder lanes — the strict subset of {@link SelectionSource} a
 * finder candidate can be tagged with at pool-build time. (`core` / `hot` /
 * `fresh` are assigned by stable-prefix membership, not by a finder.) Defined
 * via `Exclude` so it can never drift from {@link SELECTION_SOURCES}: adding a
 * finder lane there widens this automatically.
 */
export type FinderLane = Exclude<SelectionSource, "core" | "hot" | "fresh">;
