import type { SectionIndex, Slug } from "./types.js";

/**
 * Section-grain "needle" lane for memory-v3 retrieval: a lexical BM25F search
 * over a {@link SectionIndex}. Each section is a tiny two-field document — a
 * weighted `head` line (`${lastSlugSegment} — ${title}`) and the remaining
 * `body` text — so a literal term in a heading outranks the same term buried in
 * prose. Scoring happens at section grain; results are deduped to distinct
 * articles, each tagged with its best-scoring section.
 *
 * Implementation notes:
 * - Hand-rolled Okapi BM25F (no dependency). The corpus is bounded (one doc per
 *   section), so a plain inverted index is plenty.
 * - To match the validated harness the term stream includes adjacent-token
 *   bigrams (`token[i] + "_" + token[i+1]`) in addition to unigrams.
 */

/** Okapi BM25 term-frequency saturation parameter. */
const k1 = 1.5;
/** Okapi BM25 length-normalization parameter. */
const b = 0.75;

/** `head`-field weight in the BM25F term-frequency blend. */
const HEAD_WEIGHT = 2.5;
/** `body`-field weight in the BM25F term-frequency blend. */
const BODY_WEIGHT = 1;

export interface SectionNeedle {
  /**
   * Returns up to `k` distinct articles ranked by BM25F score (descending),
   * each tagged with its best-scoring section index (into the underlying
   * `SectionIndex.sections`). Ties break by `(article, ordinal)`.
   */
  query(text: string, k: number): { article: Slug; section: number }[];
  /**
   * Highest-scoring section index (into `SectionIndex.sections`) for `article`
   * against `queryText`. Returns the article's first section index when no term
   * matches (or `-1` if the article has no sections). Used by other lanes to
   * attach a matched-section descriptor to an article they surface.
   */
  bestSection(article: Slug, queryText: string): number;
}

/** Lowercase, split on non-alphanumeric, drop empties. */
function tokenizeUnigrams(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Unigrams plus adjacent-token bigrams (`a_b`), matching the harness. */
function tokenize(text: string): string[] {
  const unigrams = tokenizeUnigrams(text);
  const terms = [...unigrams];
  for (let i = 0; i + 1 < unigrams.length; i++) {
    terms.push(`${unigrams[i]}_${unigrams[i + 1]}`);
  }
  return terms;
}

/** Split a section's text into its head line and the remaining body. */
function splitHeadBody(text: string): { head: string; body: string } {
  const newline = text.indexOf("\n");
  if (newline === -1) return { head: text, body: "" };
  return { head: text.slice(0, newline), body: text.slice(newline + 1) };
}

interface Posting {
  doc: number;
  /** Field-weighted term frequency: HEAD_WEIGHT*tf_head + BODY_WEIGHT*tf_body. */
  weightedTf: number;
}

export function buildSectionNeedle(index: SectionIndex): SectionNeedle {
  const { sections } = index;
  const docCount = sections.length;

  // term -> postings (section index + weighted term frequency).
  const postings = new Map<string, Posting[]>();
  // BM25F effective document length = weighted token count per section.
  const docLengths: number[] = new Array(docCount).fill(0);
  let totalLength = 0;

  for (let doc = 0; doc < docCount; doc++) {
    const { head, body } = splitHeadBody(sections[doc]!.text);
    const headTerms = tokenize(head);
    const bodyTerms = tokenize(body);

    const length =
      HEAD_WEIGHT * headTerms.length + BODY_WEIGHT * bodyTerms.length;
    docLengths[doc] = length;
    totalLength += length;

    const weightedTf = new Map<string, number>();
    for (const term of headTerms) {
      weightedTf.set(term, (weightedTf.get(term) ?? 0) + HEAD_WEIGHT);
    }
    for (const term of bodyTerms) {
      weightedTf.set(term, (weightedTf.get(term) ?? 0) + BODY_WEIGHT);
    }

    for (const [term, tf] of weightedTf) {
      let list = postings.get(term);
      if (!list) {
        list = [];
        postings.set(term, list);
      }
      list.push({ doc, weightedTf: tf });
    }
  }

  const avgDocLength = docCount > 0 ? totalLength / docCount : 0;

  /** BM25F score per section for the given query terms. */
  function scoreSections(queryTerms: Set<string>): Map<number, number> {
    const scores = new Map<number, number>();
    if (docCount === 0) return scores;

    for (const term of queryTerms) {
      const list = postings.get(term);
      if (!list) continue;

      const idf = Math.log(
        1 + (docCount - list.length + 0.5) / (list.length + 0.5),
      );

      for (const { doc, weightedTf } of list) {
        const norm = weightedTf * (k1 + 1);
        const denom =
          weightedTf + k1 * (1 - b + b * (docLengths[doc]! / avgDocLength));
        scores.set(doc, (scores.get(doc) ?? 0) + idf * (norm / denom));
      }
    }

    return scores;
  }

  /** Deterministic order: score desc, then (article, ordinal) asc. */
  function rankSection(
    a: number,
    c: number,
    scores: Map<number, number>,
  ): number {
    const byScore = (scores.get(c) ?? 0) - (scores.get(a) ?? 0);
    if (byScore !== 0) return byScore;
    const sa = sections[a]!;
    const sc = sections[c]!;
    return sa.article.localeCompare(sc.article) || sa.ordinal - sc.ordinal;
  }

  function query(
    text: string,
    k: number,
  ): { article: Slug; section: number }[] {
    if (k <= 0 || docCount === 0) return [];

    const queryTerms = new Set(tokenize(text));
    const scores = scoreSections(queryTerms);
    if (scores.size === 0) return [];

    const ranked = [...scores.keys()].sort((a, c) => rankSection(a, c, scores));

    // Dedupe to distinct articles, keeping each article's best (first-ranked)
    // section, until we have `k` articles.
    const seen = new Set<Slug>();
    const result: { article: Slug; section: number }[] = [];
    for (const doc of ranked) {
      const article = sections[doc]!.article;
      if (seen.has(article)) continue;
      seen.add(article);
      result.push({ article, section: doc });
      if (result.length >= k) break;
    }
    return result;
  }

  function bestSection(article: Slug, queryText: string): number {
    const docs = index.byArticle.get(article);
    if (!docs || docs.length === 0) return -1;

    const queryTerms = new Set(tokenize(queryText));
    const scores = scoreSections(queryTerms);

    let best = docs[0]!;
    let bestScore = scores.get(best) ?? 0;
    for (const doc of docs) {
      const score = scores.get(doc) ?? 0;
      // Strictly-greater keeps the earliest (lowest ordinal) section on ties,
      // since `docs` is in ascending section order.
      if (score > bestScore) {
        best = doc;
        bestScore = score;
      }
    }
    return best;
  }

  return { query, bestSection };
}
