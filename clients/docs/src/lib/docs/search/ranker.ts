import MiniSearch from "minisearch";

import { extractSnippet, normalizeText } from "@/lib/docs/search/text";
import type {
  DocsSearchChunk,
  DocsSearchIndexFile,
  DocsSearchResult,
} from "@/lib/docs/search/types";

interface SearchableChunk extends DocsSearchChunk {
  keywordsText: string;
}

interface RankedChunk {
  chunk: DocsSearchChunk;
  matchedTerms: string[];
  score: number;
}

const SEARCH_BOOSTS = {
  pageTitle: 4,
  heading: 3,
  keywordsText: 2,
  breadcrumb: 1.5,
  body: 1,
} as const;

const miniSearchCache = new WeakMap<DocsSearchChunk[], MiniSearch<SearchableChunk>>();
const chunkMapCache = new WeakMap<DocsSearchChunk[], Map<string, DocsSearchChunk>>();

function toSearchableChunk(chunk: DocsSearchChunk): SearchableChunk {
  return {
    ...chunk,
    keywordsText: chunk.keywords.join(" "),
  };
}

function getChunkMap(chunks: DocsSearchChunk[]): Map<string, DocsSearchChunk> {
  const cached = chunkMapCache.get(chunks);
  if (cached) {
    return cached;
  }

  const map = new Map<string, DocsSearchChunk>();
  for (const chunk of chunks) {
    map.set(chunk.id, chunk);
  }

  chunkMapCache.set(chunks, map);
  return map;
}

function getMiniSearch(chunks: DocsSearchChunk[]): MiniSearch<SearchableChunk> {
  const cached = miniSearchCache.get(chunks);
  if (cached) {
    return cached;
  }

  const mini = new MiniSearch<SearchableChunk>({
    idField: "id",
    fields: ["pageTitle", "heading", "breadcrumb", "keywordsText", "body"],
    storeFields: ["id"],
    tokenize: (text) =>
      normalizeText(text)
        .toLowerCase()
        .split(/\W+/)
        .filter((token) => token.length > 1),
    processTerm: (term) => term.toLowerCase(),
  });

  mini.addAll(chunks.map(toSearchableChunk));
  miniSearchCache.set(chunks, mini);

  return mini;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return 10;
  }
  return Math.min(Math.max(Math.floor(limit), 1), 20);
}

function toResult(query: string, candidate: RankedChunk): DocsSearchResult {
  const snippetQuery = [...candidate.matchedTerms, query].join(" ").trim() || query;

  return {
    id: candidate.chunk.id,
    url: candidate.chunk.url,
    route: candidate.chunk.route,
    pageTitle: candidate.chunk.pageTitle,
    heading: candidate.chunk.heading,
    sectionId: candidate.chunk.sectionId,
    snippet: extractSnippet(candidate.chunk.body, snippetQuery),
    score: candidate.score,
  };
}

export function searchDocsIndex(params: {
  query: string;
  limit?: number;
  index: DocsSearchIndexFile;
}): DocsSearchResult[] {
  const query = normalizeText(params.query);
  const limit = clampLimit(params.limit);

  if (query.length < 2 || params.index.chunks.length === 0) {
    return [];
  }

  const mini = getMiniSearch(params.index.chunks);
  const chunkMap = getChunkMap(params.index.chunks);

  const matches = mini.search(query, {
    combineWith: "OR",
    prefix: true,
    fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
    boost: SEARCH_BOOSTS,
  });

  // Normalizes scores to 0..1 against the best match for the response shape.
  const maxScore = Math.max(...matches.map((match) => match.score), 1);

  return matches.slice(0, limit).flatMap((match) => {
    const chunk = chunkMap.get(String(match.id));
    if (!chunk) {
      return [];
    }

    return toResult(query, {
      chunk,
      matchedTerms: match.terms,
      score: match.score / maxScore,
    });
  });
}
