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
 * (images, audio, etc.).
 */
export const ConceptPageFrontmatterSchema = z.object({
  edges: z.array(z.string()).default([]),
  ref_files: z.array(z.string()).default([]),
});

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
