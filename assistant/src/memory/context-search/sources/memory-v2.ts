// ---------------------------------------------------------------------------
// Memory v2 — `recall` adapter for the `memory` source
// ---------------------------------------------------------------------------
//
// When v2 is enabled, the `memory` recall source reads from the v2
// concept-page subsystem (under `<workspace>/memory/concepts/`) instead of
// the legacy graph. Two retrieval paths run in parallel and merge:
//
//   1. Activation + 2-hop spreading. ANN top-K against the v2 concept-page
//      Qdrant collection seeds the candidate set; fused dense+sparse scores
//      become A_o; `spreadActivation` walks 1- and 2-hop predecessors via
//      the in-memory edge index (`getEdgeIndex`); we pick the top-N by final
//      activation.
//   2. Lexical file-search fallback. Walks `memory/concepts/*.md` and
//      term-matches the query so the agent can still find pages activation
//      missed (rare-term queries, slug literals, etc.). Mirrors the pkb
//      lexical fallback bit-for-bit so behavior is symmetric across sources.
//
// Both paths emit `RecallEvidence` with `source: "memory"` and locator
// `memory/concepts/<slug>.md` so the recall agent can hand them to
// `inspect_workspace_paths` to read full pages.
//
// Failures in either path degrade gracefully — if Qdrant is unavailable we
// still surface lexical hits, and vice versa.

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";

import { getLogger } from "../../../util/logger.js";
import { embedWithRetry } from "../../embed.js";
import { generateSparseEmbedding } from "../../embedding-backend.js";
import { spreadActivation } from "../../v2/activation.js";
import { getEdgeIndex } from "../../v2/edge-index.js";
import {
  getConceptsDir,
  readPage,
  slugFromConceptPath,
} from "../../v2/page-store.js";
import { hybridQueryConceptPages } from "../../v2/qdrant.js";
import { clampUnitInterval } from "../../validation.js";
import type {
  RecallEvidence,
  RecallSearchContext,
  RecallSearchResult,
} from "../types.js";

const log = getLogger("context-search-memory-v2-source");

/**
 * Sentinel passed to Qdrant when `config.memory.v2.ann_candidate_limit` is
 * `null` (unlimited). Qdrant's query API requires an explicit numeric
 * `limit`, so unlimited is represented as a number large enough that any
 * realistic concept-page collection is returned in full.
 *
 * Why not `Number.MAX_SAFE_INTEGER`: Qdrant's sparse-vector `SearchContext`
 * pre-allocates `limit * 16` bytes per query, so passing `MAX_SAFE_INTEGER`
 * triggers a ~144 PB allocation and SIGABRTs the Qdrant process. 1_000_000
 * is ~16 MB of pre-allocation in Qdrant — generous headroom over realistic
 * concept-page counts (low thousands today) while staying well clear of
 * the OOM cliff. Bump explicitly via `ann_candidate_limit` if you ever
 * outgrow it.
 */
const UNLIMITED_ANN_CANDIDATE_LIMIT = 1_000_000;

/** Cap individual concept-page files we are willing to read for lexical scan. */
const MEMORY_V2_LEXICAL_MAX_FILE_SIZE_BYTES = 256 * 1024;
const MEMORY_V2_LEXICAL_EXCERPT_LINE_RADIUS = 1;
const MEMORY_V2_LEXICAL_EXCERPT_MAX_CHARS = 600;

/** Excerpt length for activation hits — full body for short pages, trimmed otherwise. */
const MEMORY_V2_PAGE_EXCERPT_MAX_CHARS = 1_200;

/** Stop words filtered from query tokens before lexical matching. */
const NON_SALIENT_RECALL_TERMS = new Set([
  "a",
  "about",
  "and",
  "any",
  "as",
  "asked",
  "being",
  "details",
  "detail",
  "find",
  "for",
  "from",
  "get",
  "give",
  "happened",
  "include",
  "included",
  "including",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
  "recipient",
  "referred",
  "relevant",
  "should",
  "tell",
  "that",
  "the",
  "thing",
  "timing",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

export async function searchMemoryV2Source(
  query: string,
  context: RecallSearchContext,
  limit: number,
): Promise<RecallSearchResult> {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (normalizedLimit === 0) {
    return { evidence: [] };
  }

  const [activationEvidence, lexicalEvidence] = await Promise.all([
    activationEvidenceSafe(query, context, normalizedLimit),
    lexicalEvidenceSafe(query, context, normalizedLimit * 2),
  ]);

  return {
    evidence: mergeMemoryV2Evidence(activationEvidence, lexicalEvidence).slice(
      0,
      normalizedLimit,
    ),
  };
}

// ---------------------------------------------------------------------------
// Activation path
// ---------------------------------------------------------------------------

async function activationEvidenceSafe(
  query: string,
  context: RecallSearchContext,
  limit: number,
): Promise<RecallEvidence[]> {
  try {
    return await activationEvidence(query, context, limit);
  } catch (err) {
    log.warn(
      { err },
      "Memory v2 activation recall failed; degrading to lexical-only",
    );
    return [];
  }
}

async function activationEvidence(
  query: string,
  context: RecallSearchContext,
  limit: number,
): Promise<RecallEvidence[]> {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) return [];

  const denseResult = await embedWithRetry(context.config, [trimmedQuery], {
    signal: context.signal,
  });
  const denseVector = denseResult.vectors[0];
  if (!denseVector || denseVector.length === 0) return [];
  const sparseVector = generateSparseEmbedding(trimmedQuery);

  const annLimit =
    context.config.memory.v2.ann_candidate_limit ??
    UNLIMITED_ANN_CANDIDATE_LIMIT;
  const hits = await hybridQueryConceptPages(
    denseVector,
    sparseVector,
    annLimit,
  );
  if (hits.length === 0) return [];

  const { dense_weight: denseWeight, sparse_weight: sparseWeight } =
    context.config.memory.v2;

  let maxSparse = 0;
  for (const hit of hits) {
    if (hit.sparseScore !== undefined && hit.sparseScore > maxSparse) {
      maxSparse = hit.sparseScore;
    }
  }

  const ownActivation = new Map<string, number>();
  for (const hit of hits) {
    const dense = hit.denseScore ?? 0;
    const sparseNormalized =
      hit.sparseScore !== undefined && maxSparse > 0
        ? hit.sparseScore / maxSparse
        : 0;
    ownActivation.set(
      hit.slug,
      clampUnitInterval(denseWeight * dense + sparseWeight * sparseNormalized),
    );
  }

  const edgeIndex = await getEdgeIndex(context.workingDir);
  const { k, hops } = context.config.memory.v2;
  const { final: finalActivation } = spreadActivation(
    ownActivation,
    edgeIndex,
    k,
    hops,
  );

  const ranked = [...finalActivation.entries()]
    .sort(([slugA, valA], [slugB, valB]) => {
      if (valB !== valA) return valB - valA;
      return slugA < slugB ? -1 : slugA > slugB ? 1 : 0;
    })
    .slice(0, limit);

  const pages = await Promise.all(
    ranked.map(async ([slug, score]) => {
      try {
        const page = await readPage(context.workingDir, slug);
        if (!page) return null;
        return { slug, score, body: page.body.trim() };
      } catch (err) {
        log.warn({ err, slug }, "Failed to read concept page during recall");
        return null;
      }
    }),
  );

  const evidence: RecallEvidence[] = [];
  for (const entry of pages) {
    if (!entry || entry.body.length === 0) continue;
    const locator = `memory/concepts/${entry.slug}.md`;
    evidence.push({
      id: `memory:v2:${entry.slug}`,
      source: "memory",
      title: entry.slug,
      locator,
      excerpt: truncateExcerpt(entry.body, MEMORY_V2_PAGE_EXCERPT_MAX_CHARS),
      score: entry.score,
      metadata: {
        path: locator,
        slug: entry.slug,
        retrieval: "activation",
      },
    });
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// Lexical fallback
// ---------------------------------------------------------------------------

interface MemoryV2LexicalMatch {
  slug: string;
  excerpt: string;
  lineNumber: number;
  score: number;
  matchedTerms: string[];
}

async function lexicalEvidenceSafe(
  query: string,
  context: RecallSearchContext,
  limit: number,
): Promise<RecallEvidence[]> {
  try {
    return await lexicalEvidence(query, context, limit);
  } catch (err) {
    log.warn({ err }, "Memory v2 lexical recall fallback failed");
    return [];
  }
}

async function lexicalEvidence(
  query: string,
  context: RecallSearchContext,
  limit: number,
): Promise<RecallEvidence[]> {
  const queryTerms = tokenizeSalientRecallTerms(query);
  if (queryTerms.size === 0 || limit <= 0) return [];

  const conceptsRoot = await resolveContainedConceptsRoot(context.workingDir);
  if (!conceptsRoot) return [];

  const matches: MemoryV2LexicalMatch[] = [];
  await walkConceptsDirectory(
    conceptsRoot,
    conceptsRoot,
    queryTerms,
    matches,
    context.signal,
  );

  return matches
    .sort(compareLexicalMatches)
    .slice(0, limit)
    .map(toLexicalEvidence);
}

async function resolveContainedConceptsRoot(
  workingDir: string,
): Promise<string | null> {
  try {
    const workspaceRoot = await realpath(workingDir);
    const conceptsRoot = await realpath(getConceptsDir(workspaceRoot));
    if (!isPathInsideRoot(conceptsRoot, workspaceRoot)) {
      return null;
    }
    const rootStats = await stat(conceptsRoot);
    return rootStats.isDirectory() ? conceptsRoot : null;
  } catch {
    return null;
  }
}

async function walkConceptsDirectory(
  directoryPath: string,
  conceptsRoot: string,
  queryTerms: ReadonlySet<string>,
  matches: MemoryV2LexicalMatch[],
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);

  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    throwIfAborted(signal);

    const entryPath = join(directoryPath, entry.name);
    let entryRealPath;
    try {
      entryRealPath = await realpath(entryPath);
    } catch {
      continue;
    }

    if (!isPathInsideRoot(entryRealPath, conceptsRoot)) continue;

    let entryStats;
    try {
      entryStats = await stat(entryRealPath);
    } catch {
      continue;
    }

    if (entryStats.isDirectory()) {
      await walkConceptsDirectory(
        entryRealPath,
        conceptsRoot,
        queryTerms,
        matches,
        signal,
      );
      continue;
    }

    if (
      !entryStats.isFile() ||
      entryStats.size > MEMORY_V2_LEXICAL_MAX_FILE_SIZE_BYTES ||
      extname(entryRealPath).toLowerCase() !== ".md"
    ) {
      continue;
    }

    const match = await searchConceptFile(
      entryRealPath,
      conceptsRoot,
      queryTerms,
    );
    if (match) matches.push(match);
  }
}

async function searchConceptFile(
  filePath: string,
  conceptsRoot: string,
  queryTerms: ReadonlySet<string>,
): Promise<MemoryV2LexicalMatch | null> {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = contents.split(/\r?\n/);
  const bestLine = findBestLine(lines, queryTerms);
  if (!bestLine) return null;

  const slug = slugFromConceptPath(conceptsRoot, filePath);
  const slugTerms = termOverlap(tokenizeSalientRecallTerms(slug), queryTerms);
  const score =
    bestLine.matchedTerms.size / queryTerms.size + slugTerms.size * 0.35;

  return {
    slug,
    excerpt: buildLexicalExcerpt(lines, bestLine.lineIndex),
    lineNumber: bestLine.lineIndex + 1,
    score,
    matchedTerms: [...bestLine.matchedTerms].sort(),
  };
}

function findBestLine(
  lines: readonly string[],
  queryTerms: ReadonlySet<string>,
): { lineIndex: number; matchedTerms: Set<string> } | null {
  let best: {
    lineIndex: number;
    matchedTerms: Set<string>;
    score: number;
  } | null = null;

  lines.forEach((line, lineIndex) => {
    const lineTerms = tokenizeSalientRecallTerms(line);
    const matchedTerms = termOverlap(lineTerms, queryTerms);
    if (matchedTerms.size === 0) return;

    const score = matchedTerms.size * 10 + Math.min(lineTerms.size, 12) / 100;
    if (!best || score > best.score) {
      best = { lineIndex, matchedTerms, score };
    }
  });

  return best;
}

function buildLexicalExcerpt(
  lines: readonly string[],
  lineIndex: number,
): string {
  const start = Math.max(0, lineIndex - MEMORY_V2_LEXICAL_EXCERPT_LINE_RADIUS);
  const end = Math.min(
    lines.length,
    lineIndex + MEMORY_V2_LEXICAL_EXCERPT_LINE_RADIUS + 1,
  );
  const excerpt = lines
    .slice(start, end)
    .map((line, offset) => `${start + offset + 1}: ${line.trimEnd()}`)
    .join("\n")
    .trim();

  if (excerpt.length <= MEMORY_V2_LEXICAL_EXCERPT_MAX_CHARS) return excerpt;

  const focusedLine = `${lineIndex + 1}: ${lines[lineIndex]?.trimEnd() ?? ""}`;
  if (focusedLine.length <= MEMORY_V2_LEXICAL_EXCERPT_MAX_CHARS) {
    return focusedLine;
  }
  return `${focusedLine
    .slice(0, MEMORY_V2_LEXICAL_EXCERPT_MAX_CHARS - 3)
    .trimEnd()}...`;
}

function toLexicalEvidence(match: MemoryV2LexicalMatch): RecallEvidence {
  const locator = `memory/concepts/${match.slug}.md:${match.lineNumber}`;
  return {
    id: `memory:v2:lexical:${match.slug}:${match.lineNumber}`,
    source: "memory",
    title: match.slug,
    locator,
    excerpt: match.excerpt,
    score: match.score,
    metadata: {
      path: `memory/concepts/${match.slug}.md`,
      slug: match.slug,
      lineNumber: match.lineNumber,
      matchedTerms: match.matchedTerms,
      retrieval: "lexical",
    },
  };
}

function compareLexicalMatches(
  a: MemoryV2LexicalMatch,
  b: MemoryV2LexicalMatch,
): number {
  if (b.score !== a.score) return b.score - a.score;
  const slugCompare = a.slug.localeCompare(b.slug);
  if (slugCompare !== 0) return slugCompare;
  return a.lineNumber - b.lineNumber;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function mergeMemoryV2Evidence(
  activationEvidence: readonly RecallEvidence[],
  lexicalEvidence: readonly RecallEvidence[],
): RecallEvidence[] {
  // Activation hits already encode "this page is the best match for the query"
  // and carry the full body excerpt. Lexical hits sometimes target the same
  // slug at a specific line — keep both since the line-level excerpt can pin
  // the agent to the right region of a long page, but dedupe identical (slug,
  // excerpt) pairs that the two paths happen to produce.
  const seen = new Set<string>();
  const merged: RecallEvidence[] = [];
  for (const item of [
    ...activationEvidence,
    ...[...lexicalEvidence].sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id),
    ),
  ]) {
    const key = `${item.locator}\0${normalizeExcerpt(item.excerpt)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Helpers (mirrored from pkb.ts so behavior stays symmetric)
// ---------------------------------------------------------------------------

function tokenizeSalientRecallTerms(text: string): Set<string> {
  const terms = (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
    (term) => term.length >= 2 && !NON_SALIENT_RECALL_TERMS.has(term),
  );
  return new Set(terms);
}

function termOverlap(
  haystackTerms: ReadonlySet<string>,
  queryTerms: ReadonlySet<string>,
): Set<string> {
  const matchedTerms = new Set<string>();
  for (const term of queryTerms) {
    if (haystackTerms.has(term)) matchedTerms.add(term);
  }
  return matchedTerms;
}

function normalizeExcerpt(excerpt: string): string {
  return excerpt.trim().replace(/\s+/g, " ").toLowerCase();
}

function isPathInsideRoot(pathToCheck: string, rootRealPath: string): boolean {
  const pathRelativeToRoot = relative(rootRealPath, pathToCheck);
  return (
    pathRelativeToRoot === "" ||
    (!pathRelativeToRoot.startsWith("..") && !isAbsolute(pathRelativeToRoot))
  );
}

function truncateExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Memory v2 recall search aborted");
  }
}
