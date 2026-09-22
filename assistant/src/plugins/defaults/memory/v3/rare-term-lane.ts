import { type SectionNeedle, tokenizeUnigrams } from "./section-needle.js";
import type { SectionIndex, Slug } from "./types.js";

/**
 * Rare-term lane: surface the sections a rare query word occurs in.
 *
 * The needle ranks a section by how much of the WHOLE message it explains, so
 * the message's bulk theme decides which section of a page surfaces, and a
 * query on one clause alone cannot rank a page whose only distinctive token
 * is a single word. A unigram that occurs in at most a few sections of the
 * corpus is a near-certain signal by itself: the sections it occurs in are
 * the ones the message meant, whatever else the message is about. This lane
 * keys on those terms alone, taking each one's top sections by its own BM25F
 * contribution, so the section a rare word points at surfaces regardless of
 * the bulk theme, with no model call.
 *
 * "A few" is relative to the corpus. The df ceiling in force is
 * `min(maxDf, max(1, floor(sectionCount * maxDfFraction)))`
 * ({@link effectiveMaxDf}): `maxDf` is the absolute ceiling the defaults were
 * tuned at, and the fraction lowers it on a smaller corpus. At the defaults
 * (12 and 0.002) a corpus of 6,000 sections or more runs at 12, while a
 * corpus of a few hundred sections counts only a word unique to one section
 * as rare: ordinary words there have df at or below 12, and an absolute
 * ceiling would make most of the message "rare" and fill `cap` with noise
 * every turn. The floor of 1 keeps a word unique to one section rare on any
 * corpus.
 *
 * No token-shape filtering: a hex fragment, an identifier, or a number that
 * exists in the corpus is a legitimate match, and a token the corpus does not
 * hold has df 0 and drops out on its own. Bigram terms are never eligible.
 *
 * Hits are candidates for the selector's judgment, not evidence strong
 * enough to inject unjudged, so the caller runs the lane only when the
 * selector is on (`shadow-plugin.ts`).
 */

export interface RareTermLaneOptions {
  /** Absolute ceiling on the number of sections a term may occur in and
   *  still count as rare; the corpus-relative ceiling can only lower it
   *  (canonical value: `memory.v3.rareTerm.maxDf`). */
  maxDf: number;
  /** Fraction of the corpus's section count that bounds the df ceiling, in
   *  (0, 1]; see {@link effectiveMaxDf} (canonical value:
   *  `memory.v3.rareTerm.maxDfFraction`). */
  maxDfFraction: number;
  /** Sections surfaced per rare term, its top single-term BM25F hits
   *  (canonical value: `memory.v3.rareTerm.perTerm`). */
  perTerm: number;
  /** Hard cap on hits per turn, rarest terms first (canonical value:
   *  `memory.v3.rareTerm.cap`). */
  cap: number;
}

/** A rare-term hit: the section (its article and index into
 *  `SectionIndex.sections`) and the query term that surfaced it. */
export interface RareTermHit {
  article: Slug;
  section: number;
  term: string;
}

/**
 * The df ceiling in force for a corpus of `sectionCount` sections:
 * `min(maxDf, max(1, floor(sectionCount * maxDfFraction)))`. `maxDf` binds
 * once the corpus is large enough for the fraction to reach it; below that
 * the ceiling scales with the corpus, never under 1.
 */
export function effectiveMaxDf(
  sectionCount: number,
  {
    maxDf,
    maxDfFraction,
  }: Pick<RareTermLaneOptions, "maxDf" | "maxDfFraction">,
): number {
  return Math.min(maxDf, Math.max(1, Math.floor(sectionCount * maxDfFraction)));
}

/**
 * Surface the top `perTerm` sections of every message unigram whose corpus
 * document frequency is between 1 and the index's {@link effectiveMaxDf},
 * one hit per section, ordered rarest term first, then strongest single-term
 * score, and cut at `cap`. A section two rare terms both score is one hit
 * under the first of them in that order. Each hit carries its term so the
 * caller can tag and snippet the line on it.
 */
export function rareTermLane(
  needle: SectionNeedle,
  index: SectionIndex,
  message: string,
  { maxDf, maxDfFraction, perTerm, cap }: RareTermLaneOptions,
): RareTermHit[] {
  if (maxDf <= 0 || maxDfFraction <= 0 || perTerm <= 0 || cap <= 0) {
    return [];
  }
  const ceiling = effectiveMaxDf(index.sections.length, {
    maxDf,
    maxDfFraction,
  });

  // Every (section, term) pair a rare term scores, with the term's df. A full
  // tie sorts by term then section so the order never depends on the
  // message's word order.
  const scored: Array<{
    doc: number;
    term: string;
    df: number;
    score: number;
  }> = [];
  for (const term of new Set(tokenizeUnigrams(message))) {
    const df = needle.df(term);
    if (df < 1 || df > ceiling) {
      continue;
    }
    for (const { doc, score } of needle.scoreTerm(term, perTerm)) {
      scored.push({ doc, term, df, score });
    }
  }
  scored.sort(
    (a, c) =>
      a.df - c.df ||
      c.score - a.score ||
      a.term.localeCompare(c.term) ||
      a.doc - c.doc,
  );

  // One hit per section. A section index entry is one (page, section key),
  // so this is the (slug, sectionKey) dedupe.
  const seen = new Set<number>();
  const hits: RareTermHit[] = [];
  for (const { doc, term } of scored) {
    if (seen.has(doc)) {
      continue;
    }
    seen.add(doc);
    hits.push({ article: index.sections[doc]!.article, section: doc, term });
    if (hits.length >= cap) {
      break;
    }
  }
  return hits;
}
