// ---------------------------------------------------------------------------
// Memory v2 — Shared types
// ---------------------------------------------------------------------------
//
// Types shared across the v2 memory subsystem. Most values here cross a
// serialization boundary — YAML frontmatter, on-disk JSON, or a SQLite JSON
// column — so they ship as Zod schemas with inferred TypeScript types so
// runtime validation runs wherever they are read. The skill-autoinjection
// entry stays a plain `interface` because it is purely in-process.
//
// This file must not import from any other `memory/v2/*` module — it is the
// leaf of the v2 dependency graph.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Concept pages
// ---------------------------------------------------------------------------

/**
 * YAML frontmatter at the top of a concept page (`memory/concepts/<slug>.md`).
 *
 * `edges` is the canonical list of *outgoing* directed edges from this page.
 * Each entry is the slug of another concept page; an entry of `B` in A's
 * `edges:` means "activating A pulls in B" — activation flows A → B but not
 * B → A. The full graph is the union of every page's `edges:` list — there
 * is no separate edges-index file. `ref_files` lists paths to attached media
 * (images, audio, etc.). `ref_urls` lists external URL references (e.g.
 * citations, source links).
 *
 * `summary` is a 1-4 sentence prose description of the page. When present,
 * retrieval injects the path + summary instead of the full page so the agent
 * can decide whether to read the file. Optional because legacy pages predating
 * the summary field still parse — those fall back to full-page injection and
 * full-page-only similarity.
 */
export const ConceptPageFrontmatterSchema = z
  .object({
    edges: z.array(z.string()).default([]),
    ref_files: z.array(z.string()).default([]),
    ref_urls: z.array(z.string().url()).default([]),
    summary: z.string().optional(),
    leaves: z.array(z.string()).optional(),
    // Optional authored `"<target-slug> — <why>"` cross-links. Curated, first-class
    // edges for the memory-v3 edge lane. Declared (rather than left to the
    // `.passthrough()` catchall below) so it carries a real type and so
    // `renderPageContent` round-trips the field (the edge graph reads it back
    // from the rendered frontmatter).
    links: z.array(z.string()).optional(),
    // The memory-v3 wiki-article fields — the shape CONSOLIDATION_PROMPT_V3
    // teaches and migrated corpora arrive in. Declared (not just tolerated by
    // the catchall) so `renderPageContent` round-trips them — a programmatic
    // rewrite must not strip a page's `status:` draft marker or `title`.
    // `kind` and `status` stay free-form strings: their known values today
    // ("index", "cc-draft") are conventions of the article model, not
    // invariants this storage layer should enforce.
    title: z.string().optional(),
    slug: z.string().optional(),
    tags: z.array(z.string()).optional(),
    main: z.string().optional(),
    kind: z.string().optional(),
    status: z.string().optional(),
    // One-line live state of the page's subject (open items, deadlines,
    // what's pending), as-of dated by convention. Memory-v3 renders it on the
    // card surface so state-shaped questions can select the page. Distinct
    // from `status:` (the article-model draft marker, e.g. "cc-draft").
    current: z.string().optional(),
  })
  // `.passthrough()`, NOT `.strict()`: tolerate unknown frontmatter keys instead
  // of throwing. Migrated/converted corpora carry leaked source-page fields the
  // article model does not define (`date`, `sources`, `world`, `outcome`,
  // `as_of`, …). Under `.strict()` every such page failed `readPage()` and was
  // silently dropped from BOTH the page index and the section dense lane — a far
  // worse failure than the schema drift strictness guarded against (a bulk
  // wiki deploy lost ~45% of pages this way). Unknown keys pass through and stay
  // on disk (loss-proof); the frontmatter sweep still surfaces malformed pages.
  .passthrough();

export type ConceptPageFrontmatter = z.infer<
  typeof ConceptPageFrontmatterSchema
>;

/**
 * A single concept page on disk. The slug is the relative path from
 * `memory/concepts/` minus `.md`, using forward slashes — so `alice` and
 * `people/alice` are both valid slugs. The slug is the stable identity used
 * in edges and activation state.
 */
export const ConceptPageSchema = z.object({
  slug: z.string(),
  frontmatter: ConceptPageFrontmatterSchema,
  body: z.string(),
});

export type ConceptPage = z.infer<typeof ConceptPageSchema>;

// ---------------------------------------------------------------------------
// Activation state (per-conversation, persisted in SQLite)
// ---------------------------------------------------------------------------

/**
 * One entry in the per-conversation `everInjected` list. Tracks which
 * concept-page slug was injected on which turn so compaction can selectively
 * evict slugs whose attachments lived on compacted turns.
 */
export const EverInjectedEntrySchema = z.object({
  slug: z.string(),
  turn: z.number().int().nonnegative(),
});

export type EverInjectedEntry = z.infer<typeof EverInjectedEntrySchema>;

/**
 * Snapshot of memory v2 retrieval state for a single conversation.
 *
 * `state` is a sparse map of slug → activation in [0, 1]; only slugs above
 * `epsilon` are persisted. `everInjected` is the running list of slugs the
 * assistant has already attached to a user message, used to make injection
 * append-only and cache-stable.
 */
export const ActivationStateSchema = z.object({
  messageId: z.string(),
  state: z.record(z.string(), z.number()),
  everInjected: z.array(EverInjectedEntrySchema),
  currentTurn: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export type ActivationState = z.infer<typeof ActivationStateSchema>;

// ---------------------------------------------------------------------------
// Skill entries (synthetic concept-collection rows, not on-disk pages)
// ---------------------------------------------------------------------------

/**
 * Per-skill capability snapshot held in-process and embedded into the unified
 * `memory_v2_concept_pages` Qdrant collection under the slug `skills/<id>`.
 * `content` is the rendered `buildSkillContent` string — already capped at
 * 500 chars upstream and already containing the skill's display name — and
 * is what we embed and what we render verbatim in `### Skills You Can Use`.
 *
 * Plain interface (no Zod) because skill data does not cross a serialization
 * boundary: it is built in-process by `seedV2SkillEntries` and read in-process
 * by `renderInjectionBlock`. The Qdrant payload is not parsed back through
 * this type.
 */
export interface SkillEntry {
  id: string;
  content: string;
}

// ---------------------------------------------------------------------------
// CLI-command entries (synthetic concept-collection rows, not on-disk pages)
// ---------------------------------------------------------------------------

/**
 * Per-CLI-subcommand capability snapshot held in-process and embedded into the
 * unified `memory_v2_concept_pages` Qdrant collection under the slug
 * `cli-commands/<name>`. `content` is the full `helpInformation()` output for
 * the top-level subcommand — the embedding target, intentionally uncapped so
 * activation hints in flag descriptions and examples carry semantic weight.
 * `description` is the one-line Commander description, rendered terse in
 * `### CLI Commands You Can Use` so the injection block stays compact even
 * for verbose `--help` outputs.
 *
 * Plain interface (no Zod) — same in-process-only justification as
 * `SkillEntry`.
 */
export interface CliCommandEntry {
  id: string;
  description: string;
  content: string;
}
