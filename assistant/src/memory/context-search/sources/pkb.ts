import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

import {
  readNowScratchpad,
  readPkbContext,
} from "../../../daemon/conversation-runtime-assembly.js";
import { getLogger } from "../../../util/logger.js";
import { embedWithRetry } from "../../embed.js";
import { generateSparseEmbedding } from "../../embedding-backend.js";
import { searchPkbFiles } from "../../pkb/pkb-search.js";
import { PKB_WORKSPACE_SCOPE } from "../../pkb/types.js";
import type {
  RecallEvidence,
  RecallSearchContext,
  RecallSearchResult,
} from "../types.js";
import { isMemoryV2ReadActive } from "./memory-v2.js";

const log = getLogger("context-search-pkb-source");

const PKB_LEXICAL_MAX_FILE_SIZE_BYTES = 256 * 1024;
const PKB_LEXICAL_EXCERPT_LINE_RADIUS = 1;
const PKB_LEXICAL_EXCERPT_MAX_CHARS = 600;

const TEXT_LIKE_PKB_EXTENSIONS = new Set([".md", ".txt"]);

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

export async function searchPkbSource(
  query: string,
  context: RecallSearchContext,
  limit: number,
): Promise<RecallSearchResult> {
  if (isMemoryV2ReadActive(context.config)) {
    return { evidence: [] };
  }

  const semanticEvidence: RecallEvidence[] = [];

  try {
    const result = await embedWithRetry(context.config, [query], {
      signal: context.signal,
    });
    const queryVector = result.vectors[0];
    if (queryVector) {
      const sparseVector = generateSparseEmbedding(query);
      const hits = await searchPkbFiles(queryVector, sparseVector, limit, [
        PKB_WORKSPACE_SCOPE,
      ]);

      semanticEvidence.push(
        ...hits.map((hit, index): RecallEvidence => {
          const score = hit.hybridScore ?? hit.denseScore;
          return {
            id: `pkb:${hit.path}:${index}`,
            source: "pkb",
            title: hit.path,
            locator: hit.path,
            excerpt: hit.snippet ?? hit.path,
            score,
            metadata: {
              path: hit.path,
              denseScore: hit.denseScore,
              ...(hit.hybridScore !== undefined
                ? { hybridScore: hit.hybridScore }
                : {}),
            },
          };
        }),
      );
    }
  } catch (err) {
    log.warn(
      { err },
      "Semantic PKB recall source failed; using lexical fallback",
    );
  }

  let lexicalEvidence: RecallEvidence[] = [];
  try {
    lexicalEvidence = await searchPkbLexicalFallback(query, context, limit * 2);
  } catch (err) {
    log.warn({ err }, "Lexical PKB recall fallback failed");
  }

  return {
    evidence: mergePkbEvidence(semanticEvidence, lexicalEvidence).slice(
      0,
      limit,
    ),
  };
}

export function readPkbContextEvidence(
  context: RecallSearchContext,
): RecallEvidence[] {
  if (isMemoryV2ReadActive(context.config)) {
    return [];
  }

  const evidence: RecallEvidence[] = [];

  const pkbContext = readPkbContext();
  if (pkbContext) {
    evidence.push({
      id: "pkb:auto-inject",
      source: "pkb",
      title: "PKB auto-injected context",
      locator: "pkb:auto-inject",
      excerpt: pkbContext,
      metadata: { kind: "auto-inject" },
    });
  }

  const nowScratchpad = readNowScratchpad();
  if (nowScratchpad) {
    evidence.push({
      id: "pkb:NOW.md",
      source: "pkb",
      title: "NOW.md",
      locator: "NOW.md",
      excerpt: nowScratchpad,
      metadata: { kind: "now" },
    });
  }

  return evidence;
}

interface PkbLexicalMatch {
  relativePath: string;
  excerpt: string;
  lineNumber: number;
  score: number;
  matchedTerms: string[];
}

async function searchPkbLexicalFallback(
  query: string,
  context: RecallSearchContext,
  limit: number,
): Promise<RecallEvidence[]> {
  const queryTerms = tokenizeSalientRecallTerms(query);
  if (queryTerms.size === 0 || limit <= 0) {
    return [];
  }

  const pkbRoot = await resolveContainedPkbRoot(context.workingDir);
  if (!pkbRoot) {
    return [];
  }

  const matches: PkbLexicalMatch[] = [];
  await walkPkbDirectory(pkbRoot, pkbRoot, queryTerms, matches, context.signal);

  return matches
    .sort(comparePkbLexicalMatches)
    .slice(0, limit)
    .map(toPkbLexicalEvidence);
}

async function resolveContainedPkbRoot(
  workingDir: string,
): Promise<string | null> {
  try {
    const workspaceRoot = await realpath(workingDir);
    const pkbRoot = await realpath(join(workspaceRoot, "pkb"));
    if (!isPathInsideRoot(pkbRoot, workspaceRoot)) {
      return null;
    }

    const rootStats = await stat(pkbRoot);
    return rootStats.isDirectory() ? pkbRoot : null;
  } catch {
    return null;
  }
}

async function walkPkbDirectory(
  directoryPath: string,
  pkbRoot: string,
  queryTerms: ReadonlySet<string>,
  matches: PkbLexicalMatch[],
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

    if (!isPathInsideRoot(entryRealPath, pkbRoot)) {
      continue;
    }

    let entryStats;
    try {
      entryStats = await stat(entryRealPath);
    } catch {
      continue;
    }

    if (entryStats.isDirectory()) {
      await walkPkbDirectory(
        entryRealPath,
        pkbRoot,
        queryTerms,
        matches,
        signal,
      );
      continue;
    }

    if (
      !entryStats.isFile() ||
      entryStats.size > PKB_LEXICAL_MAX_FILE_SIZE_BYTES ||
      !TEXT_LIKE_PKB_EXTENSIONS.has(extname(entryRealPath).toLowerCase())
    ) {
      continue;
    }

    const match = await searchPkbFile(entryRealPath, pkbRoot, queryTerms);
    if (match) {
      matches.push(match);
    }
  }
}

async function searchPkbFile(
  filePath: string,
  pkbRoot: string,
  queryTerms: ReadonlySet<string>,
): Promise<PkbLexicalMatch | null> {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = contents.split(/\r?\n/);
  const bestLine = findBestPkbLine(lines, queryTerms);
  if (!bestLine) {
    return null;
  }

  const relativePath = toPkbRelativePath(pkbRoot, filePath);
  const pathTerms = termOverlap(
    tokenizeSalientRecallTerms(relativePath),
    queryTerms,
  );
  const score =
    bestLine.matchedTerms.size / queryTerms.size + pathTerms.size * 0.35;

  return {
    relativePath,
    excerpt: buildPkbExcerpt(lines, bestLine.lineIndex),
    lineNumber: bestLine.lineIndex + 1,
    score,
    matchedTerms: [...bestLine.matchedTerms].sort(),
  };
}

function findBestPkbLine(
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
    if (matchedTerms.size === 0) {
      return;
    }

    const score = matchedTerms.size * 10 + Math.min(lineTerms.size, 12) / 100;
    if (!best || score > best.score) {
      best = { lineIndex, matchedTerms, score };
    }
  });

  return best;
}

function buildPkbExcerpt(lines: readonly string[], lineIndex: number): string {
  const start = Math.max(0, lineIndex - PKB_LEXICAL_EXCERPT_LINE_RADIUS);
  const end = Math.min(
    lines.length,
    lineIndex + PKB_LEXICAL_EXCERPT_LINE_RADIUS + 1,
  );
  const excerpt = lines
    .slice(start, end)
    .map((line, offset) => `${start + offset + 1}: ${line.trimEnd()}`)
    .join("\n")
    .trim();

  if (excerpt.length <= PKB_LEXICAL_EXCERPT_MAX_CHARS) {
    return excerpt;
  }

  const focusedLine = `${lineIndex + 1}: ${lines[lineIndex]?.trimEnd() ?? ""}`;
  if (focusedLine.length <= PKB_LEXICAL_EXCERPT_MAX_CHARS) {
    return focusedLine;
  }

  return `${focusedLine
    .slice(0, PKB_LEXICAL_EXCERPT_MAX_CHARS - 3)
    .trimEnd()}...`;
}

function toPkbLexicalEvidence(match: PkbLexicalMatch): RecallEvidence {
  return {
    id: `pkb:lexical:${match.relativePath}:${match.lineNumber}`,
    source: "pkb",
    title: match.relativePath,
    locator: `${match.relativePath}:${match.lineNumber}`,
    excerpt: match.excerpt,
    score: match.score,
    metadata: {
      path: match.relativePath,
      lineNumber: match.lineNumber,
      matchedTerms: match.matchedTerms,
      retrieval: "lexical",
    },
  };
}

function comparePkbLexicalMatches(
  a: PkbLexicalMatch,
  b: PkbLexicalMatch,
): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  const pathCompare = a.relativePath.localeCompare(b.relativePath);
  if (pathCompare !== 0) {
    return pathCompare;
  }
  return a.lineNumber - b.lineNumber;
}

function mergePkbEvidence(
  semanticEvidence: readonly RecallEvidence[],
  lexicalEvidence: readonly RecallEvidence[],
): RecallEvidence[] {
  const seen = new Set<string>();
  const merged: RecallEvidence[] = [];

  for (const item of [
    ...semanticEvidence,
    ...[...lexicalEvidence].sort(compareEvidenceByScore),
  ]) {
    const key = `${item.locator}\0${normalizeExcerpt(item.excerpt)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
  }

  return merged;
}

function compareEvidenceByScore(a: RecallEvidence, b: RecallEvidence): number {
  const scoreCompare = (b.score ?? 0) - (a.score ?? 0);
  if (scoreCompare !== 0) return scoreCompare;
  return a.locator.localeCompare(b.locator);
}

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
    if (haystackTerms.has(term)) {
      matchedTerms.add(term);
    }
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

function toPkbRelativePath(rootRealPath: string, filePath: string): string {
  const relativePath = relative(rootRealPath, filePath);
  return relativePath.split(sep).join("/");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("PKB recall search aborted");
  }
}
