/**
 * The `# memory/concepts/<slug>.md` header convention for persisted
 * memory-injection blocks — builder, matcher, and slug extraction.
 *
 * Both the v2 injection renderer (`injection.ts`) and the v3 card renderers
 * (`plugins/defaults/memory-v3-shadow/card.ts` / `page-content.ts`) emit each
 * concept page under this exact header inside the block that is persisted on
 * the user message (`metadata.memoryInjectedBlock` /
 * `metadata.memoryV3InjectedBlock`) and re-attached at request build. The
 * v3 prune valve's card-section parser keys on the same header. Keeping the
 * builder and the matcher in one place is what guarantees the writers and the
 * read-side parsers never drift apart.
 *
 * Skill (`skills/<id>`) and CLI-command sections render under their own
 * `# Skill:` / `# CLI command:` headers without a recoverable slug, so they
 * are intentionally not extracted.
 *
 * Kept as a dependency-free leaf (like `memory-marker.ts`) so the
 * conversation-fork path can import it without pulling in the heavyweight
 * injection module.
 */

/** Render the concept-page path header that opens a page's section inside an
 *  injected memory block. The read-side inverse is
 *  {@link INJECTED_CONCEPT_HEADER_REGEX}. */
export function injectedConceptHeader(slug: string): string {
  return `# memory/concepts/${slug}.md`;
}

/**
 * Matches a {@link injectedConceptHeader} line inside an injected block;
 * capture group 1 is the page slug.
 *
 * Flagged `gm` for `String.prototype.matchAll`, which clones the regex per
 * spec and so never mutates this shared instance's `lastIndex`. Do NOT call
 * `exec`/`test` on it directly — a `g`-flagged regex is stateful under those.
 */
export const INJECTED_CONCEPT_HEADER_REGEX = /^# memory\/concepts\/(.+)\.md$/gm;

/** Recover the (deduplicated, in-order) concept slugs a persisted injection
 *  block contains. */
export function extractInjectedConceptSlugs(block: string): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const match of block.matchAll(INJECTED_CONCEPT_HEADER_REGEX)) {
    const slug = match[1]!;
    if (seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

/**
 * Read a persisted memory-injection block off a message's metadata JSON, or
 * `null` when absent/malformed. `key` selects the injection layer: v2's
 * `memoryInjectedBlock` or memory-v3's card block
 * (`MEMORY_V3_INJECTED_BLOCK_METADATA_KEY`).
 *
 * NOTE: `memory/conversation-crud.ts` carries a private copy of this exact
 * helper (its fork-seeding scan predates this export); consolidating it onto
 * this one is a pending cleanup tracked alongside the prune-valve work.
 */
export function readInjectedBlock(
  metadata: string | null | undefined,
  key: string,
): string | null {
  if (!metadata) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const block = (parsed as Record<string, unknown>)[key];
      if (typeof block === "string") return block;
    }
  } catch {
    // Malformed metadata — treat as no block.
  }
  return null;
}
