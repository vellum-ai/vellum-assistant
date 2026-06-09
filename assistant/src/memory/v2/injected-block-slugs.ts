/**
 * Slug extraction for persisted memory-injection blocks.
 *
 * `renderInjectionBlock` (injection.ts) renders each concept page under a
 * `# memory/concepts/<slug>.md` header inside the block that is persisted on
 * the user message as `metadata.memoryInjectedBlock` and re-attached at
 * request build. This module is the read-side inverse of that header
 * convention: given a persisted block, recover the concept slugs it contains.
 *
 * Skill (`skills/<id>`) and CLI-command sections render as plain description
 * lines without a recoverable slug, so they are intentionally not extracted.
 * The one consumer (truncated-fork everInjected seeding) tolerates that:
 * re-attaching a few synthetic capability lines once is harmless, unlike
 * re-attaching every inherited concept summary.
 *
 * Kept as a dependency-free leaf (like `memory-marker.ts`) so the
 * conversation-fork path can import it without pulling in the heavyweight
 * injection module.
 */
export function extractInjectedConceptSlugs(block: string): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const match of block.matchAll(/^# memory\/concepts\/(.+)\.md$/gm)) {
    const slug = match[1]!;
    if (seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}
