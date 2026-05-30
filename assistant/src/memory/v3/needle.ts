import type { LeafTree, Slug } from "./types.js";

/**
 * Sparse "needle" arm for memory-v3 routing: a lexical BM25 search over page
 * titles, slug tokens, summaries, and the labels of the leaves each page
 * belongs to. It augments topical (tree) routing by surfacing pages that share
 * a literal term with the query even when topical routing would miss them.
 *
 * Implementation notes:
 * - Hand-rolled Okapi BM25 (no dependency). The corpus is bounded (one doc per
 *   page), so a plain inverted index is plenty.
 * - The index is built once and held in memory. The orchestrator/plugin
 *   lazy-inits it. Rebuilding on consolidation is a documented fast-follow and
 *   intentionally out of scope here.
 */

/** Okapi BM25 term-frequency saturation parameter. */
export const k1 = 1.5;
/** Okapi BM25 length-normalization parameter. */
export const b = 0.75;

export interface NeedleIndex {
  /** Returns up to `k` slugs ranked by BM25 score (descending, ties by slug). */
  query(text: string, k: number): Slug[];
}

/** Lowercase, split on non-alphanumeric, drop empties. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

interface Posting {
  doc: number;
  tf: number;
}

export async function buildNeedleIndex(
  tree: LeafTree,
  pageSummary: (slug: Slug) => Promise<string>,
): Promise<NeedleIndex> {
  const slugs: Slug[] = [...tree.byPage.keys()];

  // term -> postings (doc index + term frequency in that doc)
  const postings = new Map<string, Posting[]>();
  const docLengths: number[] = new Array(slugs.length).fill(0);
  let totalLength = 0;

  for (let doc = 0; doc < slugs.length; doc++) {
    const slug = slugs[doc]!;

    // Title = last path segment of the slug; also index the slug tokens.
    const segments = slug.split(/[/.]/);
    const title = segments[segments.length - 1] ?? "";

    const parts: string[] = [title, slug, await pageSummary(slug)];

    for (const leafPath of tree.byPage.get(slug) ?? []) {
      const leaf = tree.leaves.get(leafPath);
      if (leaf) parts.push(leaf.description);
    }

    const tokens = tokenize(parts.join(" "));
    docLengths[doc] = tokens.length;
    totalLength += tokens.length;

    const termFreqs = new Map<string, number>();
    for (const token of tokens) {
      termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
    }
    for (const [term, tf] of termFreqs) {
      let list = postings.get(term);
      if (!list) {
        list = [];
        postings.set(term, list);
      }
      list.push({ doc, tf });
    }
  }

  const docCount = slugs.length;
  const avgDocLength = docCount > 0 ? totalLength / docCount : 0;

  function query(text: string, k: number): Slug[] {
    if (k <= 0 || docCount === 0) return [];

    const queryTerms = new Set(tokenize(text));
    const scores = new Map<number, number>();

    // O(query-terms x matching-docs): walk only the postings of query terms.
    for (const term of queryTerms) {
      const list = postings.get(term);
      if (!list) continue;

      const idf = Math.log(
        1 + (docCount - list.length + 0.5) / (list.length + 0.5),
      );

      for (const { doc, tf } of list) {
        const norm = tf * (k1 + 1);
        const denom = tf + k1 * (1 - b + b * (docLengths[doc]! / avgDocLength));
        scores.set(doc, (scores.get(doc) ?? 0) + idf * (norm / denom));
      }
    }

    return [...scores.entries()]
      .sort((a, c) => c[1] - a[1] || slugs[a[0]]!.localeCompare(slugs[c[0]]!))
      .slice(0, k)
      .map(([doc]) => slugs[doc]!);
  }

  return { query };
}
