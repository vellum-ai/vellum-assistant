import type { SectionIndex, Slug } from "./types.js";

/**
 * Section-grain "needle" lane for memory-v3 retrieval: a lexical BM25F search
 * over a {@link SectionIndex}. Each section is a tiny two-field document, a
 * weighted `head` line (`${lastSlugSegment} - ${title}`, the title capped, as
 * `sectionHeadLine` in `sections.ts` renders it) and the remaining `body`
 * text, so a literal term in a heading outranks the same term buried in
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

/** A scored section-needle hit: the article, its best-scoring section index
 *  (into `SectionIndex.sections`), and that section's raw BM25F score. */
export interface SectionNeedleScoredHit {
  article: Slug;
  section: number;
  score: number;
}

/** A single-term hit: a section index (into `SectionIndex.sections`) and the
 *  term's own BM25F contribution to that section. */
interface SectionTermHit {
  doc: number;
  score: number;
}

export interface SectionNeedle {
  /**
   * Returns up to `k` distinct articles ranked by BM25F score (descending),
   * each tagged with its best-scoring section index (into the underlying
   * `SectionIndex.sections`). Ties break by `(article, ordinal)`.
   */
  query(text: string, k: number): { article: Slug; section: number }[];
  /**
   * Like {@link query} but includes the raw BM25F score per hit, in the same
   * rank order (score desc, then (article, ordinal) asc).
   */
  queryScored(text: string, k: number): SectionNeedleScoredHit[];
  /**
   * Highest-scoring section index (into `SectionIndex.sections`) for `article`
   * against `queryText`. Returns the article's first section index when no term
   * matches (or `-1` if the article has no sections). Used by other lanes to
   * attach a matched-section descriptor to an article they surface.
   */
  bestSection(article: Slug, queryText: string): number;
  /**
   * Corpus IDF of `term` over the section index (its head+body postings): higher
   * means the term occurs in fewer sections. The entity lane gates heading
   * tokens by this so only terms distinctive enough to disambiguate become
   * entity keys (hub words like "vellum" fall below the floor).
   */
  idf(term: string): number;
  /**
   * The query terms contributing the most BM25F score to the section at
   * `doc` (an index into `SectionIndex.sections`), best first, at most `n`;
   * ties break by term. Empty when no query term occurs in that section.
   * Feeds the keyword-in-context finder snippets in `pool-select.ts`.
   */
  topTerms(doc: number, queryText: string, n: number): string[];
  /**
   * Document frequency of a single unigram: the number of sections it occurs
   * in (head or body), 0 when the corpus does not hold it. A bigram term is
   * never a single-term signal and reads 0. Feeds the rare-term lane
   * (`rare-term-lane.ts`), which keys on terms rare enough that the sections
   * they occur in are near-certain matches on their own.
   */
  df(term: string): number;
  /**
   * The top `k` sections for a single unigram by its own BM25F contribution,
   * score descending with ties broken by `(article, ordinal)`. Empty for a
   * term the corpus does not hold, for a bigram term, and for `k <= 0`.
   */
  scoreTerm(term: string, k: number): SectionTermHit[];
}

/** The characters of a needle token; the tokenizer splits on any other. */
const TOKEN_CHARS = "a-z0-9";
const NON_TOKEN_RUN = new RegExp(`[^${TOKEN_CHARS}]+`);
/** The shape of a needle term: a unigram of token characters, or a bigram
 *  of two joined by `_`. */
const TERM_SHAPE = new RegExp(`^[${TOKEN_CHARS}]+(?:_[${TOKEN_CHARS}]+)*$`);

/**
 * The needle's unigram tokenizer: lowercase, split on non-token characters,
 * drop empties. Shared with the rare-term lane so a message is tokenized
 * exactly as the corpus was indexed.
 */
export function tokenizeUnigrams(text: string): string[] {
  return text
    .toLowerCase()
    .split(NON_TOKEN_RUN)
    .filter((token) => token.length > 0);
}

/**
 * The span of the first whole-token occurrence of a needle `term` in `text`,
 * or `undefined`. The term matches case-insensitively at token boundaries,
 * with a bigram's halves separated by any run of non-token characters, so
 * the occurrence found is one the tokenizer would have indexed. Feeds the
 * keyword-in-context snippets in `pool-select.ts`.
 */
export function findTerm(
  text: string,
  term: string,
): { start: number; end: number } | undefined {
  if (!TERM_SHAPE.test(term)) {
    return undefined;
  }
  const halves = term.split("_").join(`[^${TOKEN_CHARS}]+`);
  const match = new RegExp(
    `(?<![${TOKEN_CHARS}])${halves}(?![${TOKEN_CHARS}])`,
    "i",
  ).exec(text);
  return match
    ? { start: match.index, end: match.index + match[0].length }
    : undefined;
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
  if (newline === -1) {
    return { head: text, body: "" };
  }
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

  /** Okapi IDF from a document frequency: higher for rarer terms. */
  function idfFromDf(df: number): number {
    return Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
  }

  /** Corpus IDF of `term`; an unseen term gets the maximum (df 0) IDF. */
  function idf(term: string): number {
    return idfFromDf(postings.get(term)?.length ?? 0);
  }

  /** A bigram term (`a_b`) is never eligible as a single-term signal. */
  function isUnigram(term: string): boolean {
    return !term.includes("_");
  }

  function df(term: string): number {
    return isUnigram(term) ? (postings.get(term)?.length ?? 0) : 0;
  }

  /** One term's BM25F contribution to section `doc`. */
  function termScore(doc: number, weightedTf: number, termIdf: number): number {
    const norm = weightedTf * (k1 + 1);
    const denom =
      weightedTf + k1 * (1 - b + b * (docLengths[doc]! / avgDocLength));
    return termIdf * (norm / denom);
  }

  /** BM25F score per section for the given query terms. */
  function scoreSections(queryTerms: Set<string>): Map<number, number> {
    const scores = new Map<number, number>();
    if (docCount === 0) {
      return scores;
    }

    for (const term of queryTerms) {
      const list = postings.get(term);
      if (!list) {
        continue;
      }

      const termIdf = idfFromDf(list.length);

      for (const { doc, weightedTf } of list) {
        scores.set(
          doc,
          (scores.get(doc) ?? 0) + termScore(doc, weightedTf, termIdf),
        );
      }
    }

    return scores;
  }

  /** The posting of `doc` in `list`, or `undefined` when the term is absent
   *  from that section. Sections are indexed in ascending order, so every
   *  postings list is sorted by `doc` and a binary search finds it. */
  function postingFor(list: Posting[], doc: number): Posting | undefined {
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const posting = list[mid]!;
      if (posting.doc === doc) {
        return posting;
      }
      if (posting.doc < doc) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return undefined;
  }

  function topTerms(doc: number, queryText: string, n: number): string[] {
    if (n <= 0 || doc < 0 || doc >= docCount) {
      return [];
    }
    const contributions: Array<{ term: string; score: number }> = [];
    for (const term of new Set(tokenize(queryText))) {
      const list = postings.get(term);
      const posting = list ? postingFor(list, doc) : undefined;
      if (list && posting) {
        contributions.push({
          term,
          score: termScore(doc, posting.weightedTf, idfFromDf(list.length)),
        });
      }
    }
    contributions.sort(
      (a, c) => c.score - a.score || a.term.localeCompare(c.term),
    );
    return contributions.slice(0, n).map((c) => c.term);
  }

  function scoreTerm(term: string, k: number): SectionTermHit[] {
    if (k <= 0 || !isUnigram(term)) {
      return [];
    }
    const scores = scoreSections(new Set([term]));
    return [...scores.keys()]
      .sort((a, c) => rankSection(a, c, scores))
      .slice(0, k)
      .map((doc) => ({ doc, score: scores.get(doc)! }));
  }

  /** Deterministic order: score desc, then (article, ordinal) asc. */
  function rankSection(
    a: number,
    c: number,
    scores: Map<number, number>,
  ): number {
    const byScore = (scores.get(c) ?? 0) - (scores.get(a) ?? 0);
    if (byScore !== 0) {
      return byScore;
    }
    const sa = sections[a]!;
    const sc = sections[c]!;
    return sa.article.localeCompare(sc.article) || sa.ordinal - sc.ordinal;
  }

  function queryScored(text: string, k: number): SectionNeedleScoredHit[] {
    if (k <= 0 || docCount === 0) {
      return [];
    }

    const queryTerms = new Set(tokenize(text));
    const scores = scoreSections(queryTerms);
    if (scores.size === 0) {
      return [];
    }

    const ranked = [...scores.keys()].sort((a, c) => rankSection(a, c, scores));

    // Dedupe to distinct articles, keeping each article's best (first-ranked)
    // section, until we have `k` articles.
    const seen = new Set<Slug>();
    const result: SectionNeedleScoredHit[] = [];
    for (const doc of ranked) {
      const article = sections[doc]!.article;
      if (seen.has(article)) {
        continue;
      }
      seen.add(article);
      result.push({ article, section: doc, score: scores.get(doc) ?? 0 });
      if (result.length >= k) {
        break;
      }
    }
    return result;
  }

  function query(
    text: string,
    k: number,
  ): { article: Slug; section: number }[] {
    return queryScored(text, k).map(({ article, section }) => ({
      article,
      section,
    }));
  }

  function bestSection(article: Slug, queryText: string): number {
    const docs = index.byArticle.get(article);
    if (!docs || docs.length === 0) {
      return -1;
    }

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

  return { query, queryScored, bestSection, idf, topTerms, df, scoreTerm };
}
