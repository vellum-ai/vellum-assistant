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
  lexicalScore: number;
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

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) {
    return 10;
  }
  return Math.min(Math.max(Math.floor(limit), 1), 20);
}

function normalizeLexicalScores(candidates: RankedChunk[]): RankedChunk[] {
  const maxLexical = Math.max(...candidates.map((candidate) => candidate.lexicalScore), 1);

  return candidates.map((candidate) => ({
    ...candidate,
    score: candidate.lexicalScore / maxLexical,
  }));
}

function lexicalSearch(params: {
  query: string;
  chunks: DocsSearchChunk[];
  topK: number;
}): RankedChunk[] {
  const mini = getMiniSearch(params.chunks);
  const chunkMap = getChunkMap(params.chunks);

  const raw = mini.search(params.query, {
    combineWith: "OR",
    prefix: true,
    fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
    boost: SEARCH_BOOSTS,
  });

  const ranked = raw
    .slice(0, params.topK)
    .map((result) => {
      const chunk = chunkMap.get(String(result.id));
      if (!chunk) {
        return null;
      }

      return {
        chunk,
        matchedTerms: result.terms,
        lexicalScore: result.score,
        score: result.score,
      } satisfies RankedChunk;
    })
    .filter((candidate): candidate is RankedChunk => candidate !== null);

  if (ranked.length === 0) {
    return [];
  }

  return normalizeLexicalScores(ranked).sort((a, b) => b.score - a.score);
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
    lexicalScore: candidate.lexicalScore,
  };
}

export function searchDocsIndex(params: {
  query: string;
  limit?: number;
  index: DocsSearchIndexFile;
}): { mode: "lexical"; results: DocsSearchResult[] } {
  const query = normalizeText(params.query);
  const limit = clampLimit(params.limit ?? 10);

  if (query.length < 2 || params.index.chunks.length === 0) {
    return {
      mode: "lexical",
      results: [],
    };
  }

  const lexicalTopK = Math.max(40, limit * 4);
  const candidates = lexicalSearch({
    query,
    chunks: params.index.chunks,
    topK: lexicalTopK,
  });

  return {
    mode: "lexical",
    results: candidates.slice(0, limit).map((candidate) => toResult(query, candidate)),
  };
}
