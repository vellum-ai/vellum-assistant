/**
 * Shared formatting helpers for rendering capped markdown sections
 * inside the `<memory_brief>` wrapper.
 */

export interface BriefEntry {
  /** One-line markdown bullet text (no leading `- `). */
  text: string;
}

/**
 * Render a titled markdown section with a capped number of bullet entries.
 *
 * Returns `null` when `entries` is empty so callers can easily omit absent
 * sections.  The output is a markdown string like:
 *
 * ```
 * ### Time-Relevant Context
 * - Meeting with Alice in 2 hours
 * - Quarterly review deadline tomorrow
 * ```
 */
export function renderBriefSection(
  title: string,
  entries: BriefEntry[],
  maxEntries: number,
): string | null {
  if (entries.length === 0) return null;

  const capped = entries.slice(0, maxEntries);
  const bullets = capped.map((e) => `- ${e.text}`).join("\n");
  return `### ${title}\n${bullets}`;
}
