import { wrapMemoryBlock } from "../memory-marker.js";
import { Section, Slug } from "./types.js";

/**
 * Leading instruction line of the frozen card block — byte-identical to v2's
 * `INJECTION_HEADER` (`memory/v2/injection.ts`) so the read affordance the
 * model already knows applies to cards unchanged: every card carries a
 * `# memory/concepts/<slug>.md` path header it can `file_read`.
 */
export const V3_CARDS_INJECTION_HEADER =
  'Use `file_read("memory/concepts/path/to/file.md")` to read the full pages for any of the injected memory summaries you want more information on.';

/**
 * Render the UNWRAPPED inner text of a frozen net-new card block: the v2-style
 * instruction header followed by the rendered cards, blank-line separated.
 * Returns `""` for an empty card list (the injector attaches no block and the
 * caller persists nothing). The caller wraps the result via
 * {@link wrapMemoryBlock} exactly once at injection time and persists the
 * unwrapped form to message metadata — the same wrap-on-use contract as v2's
 * `memoryInjectedBlock`.
 */
export function renderCardsBlockInner(cards: string[]): string {
  if (cards.length === 0) return "";
  return [V3_CARDS_INJECTION_HEADER, ...cards].join("\n\n");
}

/**
 * One ephemeral spotlight entry: a selected finder hit's matched section.
 * `title` is the matched section's heading; `text` its indexed section text.
 */
export interface SpotlightEntry {
  slug: Slug;
  title: string;
  text: string;
}

/**
 * Render the UNWRAPPED inner text of the ephemeral `<memory_spotlight>` block:
 * one `## memory/concepts/<slug>.md § <section heading>` header plus section
 * text per entry, blank-line separated. Returns `""` for an empty window (the
 * injector attaches no block). The caller wraps via
 * `wrapMemorySpotlightBlock`.
 */
export function renderSpotlightInner(entries: SpotlightEntry[]): string {
  return entries
    .map(
      (entry) =>
        `## memory/concepts/${entry.slug}.md § ${entry.title}\n${entry.text}`,
    )
    .join("\n\n");
}

/**
 * Render a v3 selection set into a single `<memory>…</memory>` text block,
 * injecting each slug's matched section (progressive disclosure) rather than
 * its full page body.
 *
 * INSPECTOR-ONLY: live injection no longer renders the whole selection set —
 * the injector freezes net-new CARDS into history ({@link renderCardsBlockInner})
 * and re-renders the ephemeral spotlight separately. This whole-set render
 * remains for the inspector's selection log (`selection-log-store.ts`), which
 * reconstructs an approximate view of a turn's selection after the fact.
 *
 * Pure and side-effect-free: all I/O is delegated to the injected
 * `pageContent` resolver, which is awaited once per slug in input order with
 * that slug's matched section (`sectionBySlug.get(slug)`, possibly undefined).
 * Resolution is concurrent; the rendered block preserves `slugs` order
 * regardless of which fetch settles first.
 *
 * @param slugs - The selected slugs for the turn, in the order they should
 *   appear in the rendered block.
 * @param sectionBySlug - The matched `Section` per slug; a slug with no entry
 *   (e.g. an edge-only or stable-prefix page with no current match) renders its
 *   full/lead page.
 * @param pageContent - Resolver returning a slug's rendered content given its
 *   matched section (or undefined).
 * @returns The wrapped `<memory>` block, or `""` for an empty selection (the
 *   caller renders nothing).
 */
export async function renderMemoryBlock(
  slugs: Slug[],
  sectionBySlug: Map<Slug, Section>,
  pageContent: (slug: Slug, section: Section | undefined) => Promise<string>,
): Promise<string> {
  if (slugs.length === 0) return "";

  const contents = await Promise.all(
    slugs.map((slug) => pageContent(slug, sectionBySlug.get(slug))),
  );

  return wrapMemoryBlock(contents.join("\n"));
}
