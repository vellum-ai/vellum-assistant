import { wrapMemoryBlock } from "../memory-marker.js";
import { Slug } from "./types.js";

/**
 * Render a v3 working-set selection into a single `<memory>…</memory>` text
 * block.
 *
 * Pure and side-effect-free: all I/O is delegated to the injected
 * `pageContent` resolver, which is awaited once per slug in input order. The
 * resulting block uses the shared {@link wrapMemoryBlock} marker — the same
 * wrapper the v2 graph-memory path emits — so the existing strip machinery in
 * `conversation-graph-memory.ts` already recognizes (and evicts) it.
 *
 * Resolution is concurrent; the rendered block preserves `finalInjection`
 * order regardless of which fetch settles first.
 *
 * @param finalInjection - The working-set selection for the turn, in the order
 *   it should appear in the rendered block.
 * @param pageContent - Resolver returning a page's rendered content for a slug.
 * @returns The wrapped `<memory>` block, or `""` for an empty selection (the
 *   caller injects nothing).
 */
export async function renderMemoryBlock(
  finalInjection: Slug[],
  pageContent: (slug: Slug) => Promise<string>,
): Promise<string> {
  if (finalInjection.length === 0) return "";

  const contents = await Promise.all(finalInjection.map(pageContent));

  return wrapMemoryBlock(contents.join("\n"));
}
