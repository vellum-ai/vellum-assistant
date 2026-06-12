import { injectedConceptHeader } from "../../../memory/v2/injected-block-slugs.js";
import {
  FRONTMATTER_REGEX,
  parseFrontmatterFields,
} from "../../../skills/frontmatter.js";
import type { Slug } from "./types.js";

/**
 * Compact card renderer for memory-v3: a page's head section (the `# Title`
 * line plus lead paragraphs, everything before the first `## ` heading) plus a
 * one-line section TOC. Cards are the compact injection unit — they carry
 * enough signal to act on (or `file_read` the full page) at a fraction of the
 * full-page byte cost.
 *
 * The `# memory/concepts/<slug>.md` header (shared builder:
 * `injectedConceptHeader` in `memory/v2/injected-block-slugs.ts`) matches the
 * v2 memory-block page convention, so the existing `file_read` affordance
 * instruction applies to cards unchanged.
 *
 * Pure text → text: no I/O, no LLM calls. Callers load the raw page text via
 * the existing page-store helpers (see `page-content.ts`).
 */

/** Max characters of a `links:` entry note carried into the `[linked: …]`
 * line. Notes longer than this are truncated with an ellipsis. */
const LINK_NOTE_MAX_CHARS = 80;

/** Matches a `## ` section heading line; capture group is the heading text. */
const SECTION_HEADING_REGEX = /^## (.*)$/m;

/**
 * Render one `links:` frontmatter entry (`"<target-slug> — <note>"`) for the
 * `[linked: …]` TOC line, truncating the note at {@link LINK_NOTE_MAX_CHARS}.
 * Entries with no ` — ` separator are bare target slugs and pass through.
 */
function renderLinkEntry(entry: string): string {
  const sep = entry.indexOf(" — ");
  if (sep === -1) return entry.trim();
  const target = entry.slice(0, sep).trim();
  let note = entry.slice(sep + " — ".length).trim();
  if (note.length > LINK_NOTE_MAX_CHARS) {
    note = `${note.slice(0, LINK_NOTE_MAX_CHARS).trimEnd()}…`;
  }
  return note.length > 0 ? `${target} — ${note}` : target;
}

/**
 * Build the one-line TOC for a card.
 *
 * Index pages (`kind: index` frontmatter) render their `links:` map instead of
 * section names — index sections have generic names ("Pages", "See also");
 * the link map is the real signal. All other pages (including an index with no
 * usable `links:`) render their `## ` heading names. Returns `null` when there
 * is nothing to list (the TOC line is omitted).
 */
function renderTocLine(
  body: string,
  fields: Record<string, unknown>,
): string | null {
  if (fields.kind === "index" && Array.isArray(fields.links)) {
    const entries = fields.links
      .filter((entry): entry is string => typeof entry === "string")
      .map(renderLinkEntry)
      .filter((entry) => entry.length > 0);
    if (entries.length > 0) return `[linked: ${entries.join(" · ")}]`;
  }

  const headings = [...body.matchAll(new RegExp(SECTION_HEADING_REGEX, "gm"))]
    .map((match) => match[1]!.trim())
    .filter((heading) => heading.length > 0);
  if (headings.length === 0) return null;
  return `[sections: ${headings.map((h) => `§${h}`).join(" · ")}]`;
}

/** Max characters of a `current:` line carried onto the card. A `current:` is
 * one line by contract; the cap keeps a runaway value from bloating every
 * render of the card. */
const CURRENT_MAX_CHARS = 280;

/**
 * Render a page's `current:` frontmatter (one-line live state) as a card
 * annotation, or `null` when the page has none. Whitespace-collapsed and
 * capped at {@link CURRENT_MAX_CHARS}.
 */
function renderCurrentLine(fields: Record<string, unknown>): string | null {
  const current = fields.current;
  if (typeof current !== "string") return null;
  const collapsed = current.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  const capped =
    collapsed.length > CURRENT_MAX_CHARS
      ? `${collapsed.slice(0, CURRENT_MAX_CHARS).trimEnd()}…`
      : collapsed;
  return `[current: ${capped}]`;
}

/**
 * Render a page's compact card: header marker, optional annotation line, head
 * section (uncapped — the corpus's rare long leads inject whole; a length cap
 * is a deliberate non-feature), and one-line TOC.
 *
 * ```
 * # memory/concepts/<slug>.md
 * [lane: fresh · updated 2026-06-10 14:23]
 * <head section verbatim>
 *
 * [sections: §… · §…]
 * ```
 *
 * The annotation renders directly under the header: selector-visible metadata
 * must sit on the always-rendered card surface (section-grain rendering can
 * hide anything that lives only inside page content). Annotations must derive
 * only from lane-init state (lane membership, page mtime) so the card stays
 * byte-identical across turns between lane recomputes.
 *
 * A page's `current:` frontmatter (one-line live state — open items,
 * deadlines, what's pending) renders the same way, first: it exists so
 * state-shaped questions can select the page, which only works if the
 * selector can see it on every card render. It changes only when the page is
 * edited (consolidation), so it shares the lane annotation's cache story.
 *
 * The TOC line is omitted when the page has no `## ` sections and no usable
 * `links:`. Deterministic for a given (slug, rawPageText, annotation).
 */
export function renderCard(
  slug: Slug,
  rawPageText: string,
  annotation?: string,
): string {
  const parsed = parseFrontmatterFields(rawPageText);
  // `parseFrontmatterFields` returns null both for "no frontmatter block" and
  // "block present but YAML failed to parse" — strip the block either way so a
  // malformed page never leaks raw frontmatter into the card head.
  const body = parsed
    ? parsed.body
    : rawPageText.replace(FRONTMATTER_REGEX, "");
  const fields = parsed?.fields ?? {};

  const firstHeading = SECTION_HEADING_REGEX.exec(body);
  const head = (firstHeading ? body.slice(0, firstHeading.index) : body).trim();

  let card = injectedConceptHeader(slug);
  const current = renderCurrentLine(fields);
  if (current !== null) card += `\n${current}`;
  if (annotation !== undefined && annotation.length > 0) {
    card += `\n${annotation}`;
  }
  if (head.length > 0) card += `\n${head}`;

  const toc = renderTocLine(body, fields);
  if (toc !== null) card += `\n\n${toc}`;

  return card;
}

/** UTF-8 byte length of a rendered card (prune-valve and footprint
 * accounting both budget in bytes, not characters). */
export function cardBytes(card: string): number {
  return Buffer.byteLength(card, "utf8");
}
