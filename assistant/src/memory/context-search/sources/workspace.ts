import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

import type {
  RecallEvidence,
  RecallSearchContext,
  RecallSearchResult,
} from "../types.js";

export const WORKSPACE_SOURCE_MAX_FILE_SIZE_BYTES = 256 * 1024;
export const WORKSPACE_SOURCE_MAX_SCANNED_FILES = 500;

const EXCERPT_LINE_RADIUS = 1;
const EXCERPT_MAX_CHARS = 600;

const HIGH_PRIORITY_DIR_NAMES = new Map<string, number>([
  ["pkb", 10],
  ["journal", 20],
  ["scratch", 30],
  ["users", 40],
  ["work", 45],
]);

const LOW_PRIORITY_DIR_NAMES = new Map<string, number>([
  ["conversations", 50],
  ["data", 60],
  ["backups", 70],
  ["logs", 80],
]);

const GENERATED_OR_DEPENDENCY_DIR_NAMES = new Set([
  ".git",
  ".private",
  "node_modules",
  "dist",
  "build",
  ".cache",
  ".turbo",
  ".next",
  "coverage",
  "target",
]);

const SECRET_SEGMENT_NAMES = new Set([
  "protected",
  "gateway-security",
  "ces-security",
]);

const TEXT_LIKE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".swift",
  ".sh",
  ".toml",
  ".html",
  ".css",
  ".sql",
]);

interface WorkspaceMatch {
  relativePath: string;
  excerpt: string;
  lineNumber: number;
  score: number;
  fileSizeBytes: number;
  matchedTerms: string[];
}

interface WalkState {
  scannedFiles: number;
  visitedDirs: Set<string>;
}

export async function searchWorkspaceSource(
  query: string,
  context: RecallSearchContext,
  limit: number,
): Promise<RecallSearchResult> {
  const queryTerms = tokenize(query);
  if (queryTerms.size === 0 || limit <= 0) {
    return { evidence: [] };
  }

  const rootRealPath = await resolveRoot(context.workingDir);
  if (!rootRealPath) {
    return { evidence: [] };
  }

  const matches: WorkspaceMatch[] = [];
  const state: WalkState = {
    scannedFiles: 0,
    visitedDirs: new Set([rootRealPath]),
  };

  await walkDirectory(rootRealPath, rootRealPath, queryTerms, matches, state, {
    signal: context.signal,
  });

  const evidence = matches
    .sort(compareWorkspaceMatches)
    .slice(0, limit)
    .map(toEvidence);

  return { evidence };
}

async function resolveRoot(workingDir: string): Promise<string | null> {
  try {
    const rootRealPath = await realpath(workingDir);
    const rootStats = await stat(rootRealPath);
    return rootStats.isDirectory() ? rootRealPath : null;
  } catch {
    return null;
  }
}

async function walkDirectory(
  directoryPath: string,
  rootRealPath: string,
  queryTerms: ReadonlySet<string>,
  matches: WorkspaceMatch[],
  state: WalkState,
  options: { signal: AbortSignal | undefined },
): Promise<boolean> {
  throwIfAborted(options.signal);

  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return true;
  }

  entries.sort((a, b) =>
    compareDirectoryEntries(rootRealPath, directoryPath, a, b),
  );

  for (const entry of entries) {
    throwIfAborted(options.signal);
    if (state.scannedFiles >= WORKSPACE_SOURCE_MAX_SCANNED_FILES) {
      return false;
    }

    if (shouldSkipSegmentName(entry.name)) {
      continue;
    }

    const entryPath = join(directoryPath, entry.name);
    const entryRealPath = await resolveContainedPath(entryPath, rootRealPath);
    if (!entryRealPath) {
      continue;
    }

    const realRelativePath = toWorkspaceRelativePath(
      rootRealPath,
      entryRealPath,
    );
    if (
      realRelativePath !== "" &&
      shouldSkipRelativePath(realRelativePath.split("/"))
    ) {
      continue;
    }

    let entryStats;
    try {
      entryStats = await stat(entryRealPath);
    } catch {
      continue;
    }

    if (entryStats.isDirectory()) {
      if (state.visitedDirs.has(entryRealPath)) {
        continue;
      }
      state.visitedDirs.add(entryRealPath);
      const shouldContinue = await walkDirectory(
        entryRealPath,
        rootRealPath,
        queryTerms,
        matches,
        state,
        options,
      );
      if (!shouldContinue) {
        return false;
      }
      continue;
    }

    if (!entryStats.isFile()) {
      continue;
    }

    const lexicalRelativePath = toWorkspaceRelativePath(
      rootRealPath,
      entryPath,
    );
    if (
      shouldSkipWorkspaceFile(lexicalRelativePath) ||
      shouldSkipFilePath(lexicalRelativePath) ||
      shouldSkipFilePath(realRelativePath) ||
      entryStats.size > WORKSPACE_SOURCE_MAX_FILE_SIZE_BYTES
    ) {
      continue;
    }

    state.scannedFiles += 1;
    const match = await searchFile(
      entryRealPath,
      lexicalRelativePath,
      entryStats.size,
      queryTerms,
    );
    if (match) {
      matches.push(match);
    }
  }

  return true;
}

async function resolveContainedPath(
  entryPath: string,
  rootRealPath: string,
): Promise<string | null> {
  try {
    const entryRealPath = await realpath(entryPath);
    return isPathInsideRoot(entryRealPath, rootRealPath) ? entryRealPath : null;
  } catch {
    return null;
  }
}

async function searchFile(
  filePath: string,
  relativePath: string,
  fileSizeBytes: number,
  queryTerms: ReadonlySet<string>,
): Promise<WorkspaceMatch | null> {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = contents.split(/\r?\n/);
  const bestLine = findBestLine(lines, queryTerms);
  if (!bestLine) {
    return null;
  }

  const pathTerms = termOverlap(tokenize(relativePath), queryTerms);
  const score =
    bestLine.matchedTerms.size / queryTerms.size + pathTerms.size * 0.05;

  return {
    relativePath,
    excerpt: buildExcerpt(lines, bestLine.lineIndex),
    lineNumber: bestLine.lineIndex + 1,
    score,
    fileSizeBytes,
    matchedTerms: [...bestLine.matchedTerms].sort(),
  };
}

function findBestLine(
  lines: readonly string[],
  queryTerms: ReadonlySet<string>,
): { lineIndex: number; matchedTerms: Set<string> } | null {
  let best: { lineIndex: number; matchedTerms: Set<string> } | null = null;

  lines.forEach((line, lineIndex) => {
    const lineTerms = tokenize(line);
    const matchedTerms = termOverlap(lineTerms, queryTerms);
    if (matchedTerms.size === 0) {
      return;
    }

    if (!best || matchedTerms.size > best.matchedTerms.size) {
      best = { lineIndex, matchedTerms };
    }
  });

  return best;
}

function buildExcerpt(lines: readonly string[], lineIndex: number): string {
  const start = Math.max(0, lineIndex - EXCERPT_LINE_RADIUS);
  const end = Math.min(lines.length, lineIndex + EXCERPT_LINE_RADIUS + 1);
  const excerpt = lines
    .slice(start, end)
    .map((line, offset) => `${start + offset + 1}: ${line.trimEnd()}`)
    .join("\n")
    .trim();

  if (excerpt.length <= EXCERPT_MAX_CHARS) {
    return excerpt;
  }

  const focusedLine = `${lineIndex + 1}: ${lines[lineIndex]?.trimEnd() ?? ""}`;
  if (focusedLine.length <= EXCERPT_MAX_CHARS) {
    return focusedLine;
  }

  return `${focusedLine.slice(0, EXCERPT_MAX_CHARS - 3).trimEnd()}...`;
}

function toEvidence(match: WorkspaceMatch): RecallEvidence {
  return {
    id: `workspace:${match.relativePath}:${match.lineNumber}`,
    source: "workspace",
    title: match.relativePath,
    locator: `${match.relativePath}:${match.lineNumber}`,
    excerpt: match.excerpt,
    score: match.score,
    metadata: {
      path: match.relativePath,
      lineNumber: match.lineNumber,
      fileSizeBytes: match.fileSizeBytes,
      matchedTerms: match.matchedTerms,
    },
  };
}

function compareWorkspaceMatches(a: WorkspaceMatch, b: WorkspaceMatch): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  const pathCompare = a.relativePath.localeCompare(b.relativePath);
  if (pathCompare !== 0) {
    return pathCompare;
  }
  return a.lineNumber - b.lineNumber;
}

function compareDirectoryEntries(
  rootRealPath: string,
  directoryPath: string,
  a: { name: string; isDirectory(): boolean },
  b: { name: string; isDirectory(): boolean },
): number {
  const aRelativePath = toWorkspaceRelativePath(
    rootRealPath,
    join(directoryPath, a.name),
  );
  const bRelativePath = toWorkspaceRelativePath(
    rootRealPath,
    join(directoryPath, b.name),
  );
  const priorityCompare =
    getTraversalPriority(aRelativePath, a.isDirectory()) -
    getTraversalPriority(bRelativePath, b.isDirectory());
  if (priorityCompare !== 0) return priorityCompare;
  return a.name.localeCompare(b.name);
}

function getTraversalPriority(
  relativePath: string,
  isDirectory: boolean,
): number {
  if (!relativePath.includes("/") && !isDirectory) {
    return 0;
  }

  const [firstSegment = ""] = relativePath.split("/");
  const lowerFirstSegment = firstSegment.toLowerCase();
  return (
    HIGH_PRIORITY_DIR_NAMES.get(lowerFirstSegment) ??
    LOW_PRIORITY_DIR_NAMES.get(lowerFirstSegment) ??
    46
  );
}

function shouldSkipFilePath(relativePath: string): boolean {
  const pathSegments = relativePath.split("/");
  if (shouldSkipRelativePath(pathSegments)) {
    return true;
  }

  return !TEXT_LIKE_EXTENSIONS.has(extname(relativePath).toLowerCase());
}

function shouldSkipWorkspaceFile(relativePath: string): boolean {
  const pathSegments = relativePath.split("/");
  return (
    pathSegments.length === 3 &&
    pathSegments[0] === "conversations" &&
    pathSegments[2] === "meta.json"
  );
}

function shouldSkipRelativePath(pathSegments: readonly string[]): boolean {
  return pathSegments.some(shouldSkipSegmentName);
}

function shouldSkipSegmentName(name: string): boolean {
  const lowerName = name.toLowerCase();
  return (
    GENERATED_OR_DEPENDENCY_DIR_NAMES.has(lowerName) ||
    lowerName.startsWith(".env") ||
    lowerName.includes("key") ||
    lowerName.includes("secret") ||
    lowerName.includes("token") ||
    lowerName.startsWith("credentials") ||
    SECRET_SEGMENT_NAMES.has(lowerName)
  );
}

function isPathInsideRoot(pathToCheck: string, rootRealPath: string): boolean {
  const pathRelativeToRoot = relative(rootRealPath, pathToCheck);
  return (
    pathRelativeToRoot === "" ||
    (!pathRelativeToRoot.startsWith("..") && !isAbsolute(pathRelativeToRoot))
  );
}

function toWorkspaceRelativePath(
  rootRealPath: string,
  filePath: string,
): string {
  const relativePath = relative(rootRealPath, filePath);
  return relativePath.split(sep).join("/");
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Workspace recall search aborted");
  }
}
