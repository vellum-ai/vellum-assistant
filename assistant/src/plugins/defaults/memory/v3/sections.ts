import type { Section, SectionIndex, Slug } from "./types.js";

/**
 * Section-grain index builder for memory-v3 lane retrieval.
 *
 * Splits each page body into sections at `## ` headings — text before the
 * first heading is the page lead (ordinal 0) — and emits a flat, deterministic
 * `SectionIndex`. Over-long sections are chunked so each `Section.text` fits a
 * typical embedding window. The function is pure: it does no I/O of its own
 * (the caller supplies `pageBody`), no LLM calls, and no Qdrant/daemon wiring.
 */

/**
 * Max `Section.text` length in characters. Sections longer than this are split
 * into multiple ordered `Section`s sharing the same `(article, ordinal)` so the
 * embedding backend never receives an over-window input.
 */
export const SECTION_CHUNK_CHARS = 6000;

/** Last `/`- or `.`-delimited segment of a slug (used for the head line). */
function lastSlugSegment(slug: Slug): string {
  const segments = slug.split(/[/.]/);
  return segments[segments.length - 1] ?? slug;
}

/**
 * The synthetic head line prepended to a section's text for lexical and dense
 * matching: the slug's last segment and the section title, so a query naming
 * either scores the section. The injection renderer strips it back off via
 * {@link sectionBody}.
 */
export function sectionHeadLine(article: Slug, title: string): string {
  return `${lastSlugSegment(article)} — ${title}`;
}

/**
 * A section's text without its synthetic head line. Only the first chunk of a
 * split section carries the head line, so the strip is keyed on the text
 * actually starting with it rather than on chunk position.
 */
export function sectionBody(section: Section): string {
  const head = sectionHeadLine(section.article, section.title);
  if (section.text === head) {
    return "";
  }
  if (section.text.startsWith(`${head}\n`)) {
    return section.text.slice(head.length + 1);
  }
  return section.text;
}

interface RawSection {
  title: string;
  body: string;
}

/**
 * Split a frontmatter-stripped markdown body into raw sections. The text before
 * the first `## ` heading is the lead (title `""`); each subsequent `## `
 * heading starts a new section whose title is the heading text.
 */
function splitIntoRawSections(body: string): RawSection[] {
  // Always seed a lead section (title `""`). The lead may stay empty, so a
  // headingless or empty page still yields a single ordinal-0 section.
  const sections: { title: string; lines: string[] }[] = [
    { title: "", lines: [] },
  ];

  for (const line of body.split("\n")) {
    const heading = /^## (.*)$/.exec(line);
    if (heading) {
      sections.push({ title: heading[1]!.trim(), lines: [] });
    } else {
      sections[sections.length - 1]!.lines.push(line);
    }
  }

  return sections.map((s) => ({ title: s.title, body: s.lines.join("\n") }));
}

/**
 * Split `text` into chunks no longer than `SECTION_CHUNK_CHARS`, preferring to
 * break on newlines so chunks stay readable. Order is preserved.
 */
function chunkText(text: string): string[] {
  if (text.length <= SECTION_CHUNK_CHARS) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > SECTION_CHUNK_CHARS) {
    const window = remaining.slice(0, SECTION_CHUNK_CHARS);
    const newlineBreak = window.lastIndexOf("\n");
    // Only break on a newline if it leaves a non-trivial chunk; otherwise hard
    // split at the window boundary to guarantee forward progress.
    const breakAt = newlineBreak > 0 ? newlineBreak : SECTION_CHUNK_CHARS;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).replace(/^\n/, "");
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

/** A raw section's indexed text chunks: the synthetic head line plus the
 *  body, split to the embedding window. */
function rawSectionChunks(article: Slug, raw: RawSection): string[] {
  return chunkText(`${sectionHeadLine(article, raw.title)}\n${raw.body}`);
}

/**
 * The lead section (ordinal 0) of one page body, built by the same split and
 * chunk rules as {@link buildSectionIndex} so its text and key are exactly
 * the index's own lead for that page. For callers that need a single page's
 * lead (the injector's unmatched-page fallback) without indexing the corpus.
 */
export function leadSectionOfBody(article: Slug, body: string): Section {
  const raw = splitIntoRawSections(body)[0]!;
  return {
    article,
    title: raw.title,
    text: rawSectionChunks(article, raw)[0]!,
    ordinal: 0,
  };
}

export async function buildSectionIndex(
  slugs: Slug[],
  pageBody: (slug: Slug) => Promise<string>,
): Promise<SectionIndex> {
  const sections: Section[] = [];

  // Sort slugs so the flat `sections` array is deterministic across runs.
  for (const article of [...slugs].sort((a, b) => a.localeCompare(b))) {
    const body = await pageBody(article);

    let ordinal = 0;
    // Per-title occurrence counter over HEADINGS, not chunks: the n-th repeat
    // of a heading keys as `title#<n>`, and the chunks of one heading key as
    // `~<chunk>` on top of that, so re-chunking a heading never renumbers a
    // later repeat of it (see `sectionKey` in `types.ts`).
    const occurrences = new Map<string, number>();
    for (const raw of splitIntoRawSections(body)) {
      const occurrence = occurrences.get(raw.title) ?? 0;
      occurrences.set(raw.title, occurrence + 1);
      for (const [chunk, text] of rawSectionChunks(article, raw).entries()) {
        sections.push({
          article,
          title: raw.title,
          text,
          ordinal: ordinal++,
          ...(occurrence > 0 ? { occurrence } : {}),
          ...(chunk > 0 ? { chunk } : {}),
        });
      }
    }
  }

  const byArticle = new Map<Slug, number[]>();
  for (let i = 0; i < sections.length; i++) {
    const article = sections[i]!.article;
    let indices = byArticle.get(article);
    if (!indices) {
      indices = [];
      byArticle.set(article, indices);
    }
    indices.push(i);
  }

  return { sections, byArticle };
}
