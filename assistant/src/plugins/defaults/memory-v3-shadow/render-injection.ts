import { wrapMemoryBlock } from "../../../memory/memory-marker.js";
import { Section, Slug } from "./types.js";

/**
 * Render a v3 working-set selection into a single `<memory>…</memory>` text
 * block, injecting each slug's matched section (progressive disclosure) rather
 * than its full page body.
 *
 * Pure and side-effect-free: all I/O is delegated to the injected
 * `pageContent` resolver, which is awaited once per slug in input order with
 * that slug's matched section (`sectionBySlug.get(slug)`, possibly undefined).
 * The resulting block uses the shared {@link wrapMemoryBlock} marker — the same
 * wrapper the v2 graph-memory path emits — so the existing strip machinery in
 * `conversation-graph-memory.ts` already recognizes (and evicts) it.
 *
 * Resolution is concurrent; the rendered block preserves `finalInjection`
 * order regardless of which fetch settles first.
 *
 * @param finalInjection - The working-set selection for the turn, in the order
 *   it should appear in the rendered block.
 * @param sectionBySlug - The matched `Section` per slug; a slug with no entry
 *   (e.g. carry-forward with no current match) renders its full/lead page.
 * @param pageContent - Resolver returning a slug's rendered content given its
 *   matched section (or undefined).
 * @returns The wrapped `<memory>` block, or `""` for an empty selection (the
 *   caller injects nothing).
 */
export async function renderMemoryBlock(
  finalInjection: Slug[],
  sectionBySlug: Map<Slug, Section>,
  pageContent: (slug: Slug, section: Section | undefined) => Promise<string>,
): Promise<string> {
  if (finalInjection.length === 0) return "";

  const contents = await Promise.all(
    finalInjection.map((slug) => pageContent(slug, sectionBySlug.get(slug))),
  );

  return wrapMemoryBlock(contents.join("\n"));
}
