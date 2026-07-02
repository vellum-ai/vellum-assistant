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
 * Surface the heading sections the message's distinctive tokens name, ranked by
 * how many of those tokens a heading contains, deduped to distinct articles and
 * truncated to `cap`. Ranking before truncation is what makes multi-token names
 * work: for "Alice Chen", the `## Alice Chen` heading (two matched tokens)
 * outranks the many `## Alice …` pages (one token each), so the exact page is
 * never starved out of the cap by a common first name — and a message word that
 * is not an entity heading (e.g. "sale", "glad") still yields nothing, keeping
 * the lane precise. Each hit carries its heading section index (into
 * `SectionIndex.sections`) so the caller renders the matched section.
 */
export function entityLane(
  entity: EntityIndex,
  index: SectionIndex,
  message: string,
  cap: number,
): { article: Slug; section: number }[] {
  if (cap <= 0) return [];

  // Per heading section hit by ≥1 message token, count how many DISTINCT message
  // tokens its heading contains (the entity index maps token → sections whose
  // heading holds it, so the per-section hit count IS that heading-overlap).
  const sectionScore = new Map<number, number>();
  for (const token of new Set(tokenize(message))) {
    for (const doc of entity.get(token) ?? []) {
      sectionScore.set(doc, (sectionScore.get(doc) ?? 0) + 1);
    }
  }

  // Collapse to one representative section per article: the highest-overlap
  // heading (ties → lowest section index, for determinism).
  const best = new Map<Slug, { section: number; score: number }>();
  for (const [doc, score] of sectionScore) {
    const article = index.sections[doc]!.article;
    const cur = best.get(article);
    if (
      !cur ||
      score > cur.score ||
      (score === cur.score && doc < cur.section)
    ) {
      best.set(article, { section: doc, score });
    }
  }

  // Rank articles by descending overlap (multi-token names first), tie-broken by
  // section index, then take the top `cap`.
  return [...best.entries()]
    .sort((a, c) => c[1].score - a[1].score || a[1].section - c[1].section)
    .slice(0, cap)
    .map(([article, { section }]) => ({ article, section }));
}
