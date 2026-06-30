import type { SectionIndex, Slug } from "./types.js";

/**
 * Entity lane: surface the section whose `## ` HEADING names an entity the
 * turn's message mentions.
 *
 * The needle ranks a section by how much of the WHOLE message it explains —
 * additive BM25, which a long, multi-topic message dilutes so a single named
 * entity drowns under the bulk theme (e.g. "who is Alice again?" buried in a
 * message mostly about a funding fight). The entity lane keys on the corpus's own
 * heading vocabulary instead: a distinctive token that appears BOTH in the
 * message AND in a section heading is a strong "the user named this thing"
 * signal, independent of how much else the message is about. The catalog spans
 * every heading, so it covers people, places, projects, products, and bots
 * alike — every entity the corpus has a section about — with no curated name
 * list and no model call.
 */

/** Lowercase, split on non-alphanumeric, drop one-character tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

/**
 * Distinctive heading token → the indices (into `SectionIndex.sections`) of the
 * sections whose heading contains it, in section order so a lookup is
 * deterministic.
 */
export type EntityIndex = Map<string, number[]>;

/**
 * Build the entity catalog over section headings. `isDistinctive` gates out hub
 * tokens — words common enough across the corpus that an exact match cannot
 * disambiguate (e.g. "vellum", "the", "people"); such pages ride the core/hot
 * lanes instead. The needle's corpus IDF is the natural source: a token is
 * distinctive when its IDF clears a floor. Lead sections (no heading, empty
 * title) contribute nothing.
 */
export function buildEntityIndex(
  index: SectionIndex,
  isDistinctive: (token: string) => boolean,
): EntityIndex {
  const byToken: EntityIndex = new Map();
  for (let doc = 0; doc < index.sections.length; doc++) {
    const title = index.sections[doc]!.title;
    if (title.length === 0) continue;
    for (const token of new Set(tokenize(title))) {
      if (!isDistinctive(token)) continue;
      let docs = byToken.get(token);
      if (!docs) {
        docs = [];
        byToken.set(token, docs);
      }
      docs.push(doc);
    }
  }
  return byToken;
}

/**
 * For each distinctive entity token the message names, surface the matching
 * heading section(s), deduped to distinct articles and capped at `cap`. A
 * message word that is not an entity heading (e.g. "sale", "glad") yields
 * nothing, so the lane stays precise where a raw rare-term sweep would inject
 * noise. Each hit carries its heading section index (into
 * `SectionIndex.sections`) so the caller renders the matched section.
 */
export function entityLane(
  entity: EntityIndex,
  index: SectionIndex,
  message: string,
  cap: number,
): { article: Slug; section: number }[] {
  if (cap <= 0) return [];
  const out: { article: Slug; section: number }[] = [];
  const seen = new Set<Slug>();
  for (const token of new Set(tokenize(message))) {
    const docs = entity.get(token);
    if (!docs) continue;
    for (const doc of docs) {
      const article = index.sections[doc]!.article;
      if (seen.has(article)) continue;
      seen.add(article);
      out.push({ article, section: doc });
      if (out.length >= cap) return out;
    }
  }
  return out;
}
