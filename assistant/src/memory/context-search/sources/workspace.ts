import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

import type {
  RecallEvidence,
  RecallSearchContext,
  RecallSearchResult,
} from "../types.js";

export const WORKSPACE_SOURCE_MAX_FILE_SIZE_BYTES = 256 * 1024;
export const WORKSPACE_SOURCE_MAX_SCANNED_FILES = 500;
const WORKSPACE_INSPECT_MAX_PATHS = 5;

const EXCERPT_LINE_RADIUS = 1;
const EXCERPT_MAX_CHARS = 600;
const SECTION_EXCERPT_MAX_CHARS = 1_200;
const STRUCTURED_JSON_EXCERPT_MAX_CHARS = 1_400;
const MAX_SECTION_MATCHES_PER_FILE = 2;
const MAX_LINE_MATCHES_PER_FILE = 1;

const PATH_LITERAL_PATTERN =
  /(?:^|[\s"'`([{<])((?:\.?[A-Za-z0-9_@~.-]+\/)*\.?[A-Za-z0-9_@~.-]+\.(?:md|txt|json|yaml|yml|toml|html|css|ts|tsx|js|jsx|py|swift|sh|sql))(?:[:#]\d+)?/g;

const WORKSPACE_BUCKETS: readonly WorkspaceBucket[] = [
  { name: "root", relativePath: "", budget: 100, rootFilesOnly: true },
  { name: "pkb", relativePath: "pkb", budget: 500 },
  { name: "memory", relativePath: "memory", budget: 500 },
  { name: "journal", relativePath: "journal", budget: 250 },
  { name: "scratch", relativePath: "scratch", budget: 500 },
  { name: "users", relativePath: "users", budget: 250 },
  { name: "work", relativePath: "work", budget: 250 },
  { name: "data-apps", relativePath: "data/apps", budget: 250 },
  { name: "conversations", relativePath: "conversations", budget: 150 },
  { name: "data", relativePath: "data", budget: 150 },
  { name: "backups", relativePath: "backups", budget: 100 },
  { name: "logs", relativePath: "logs", budget: 50 },
  { name: "other", relativePath: null, budget: 150 },
];

const KNOWN_BUCKET_TOP_LEVEL_DIRS = new Set(
  WORKSPACE_BUCKETS.flatMap((bucket) => {
    if (!bucket.relativePath) return [];
    return [bucket.relativePath.split("/")[0] ?? ""];
  }),
);

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
  "browser-profile",
  "embedding-models",
  "vellum-assistant",
]);

const SECRET_SEGMENT_NAMES = new Set([
  "protected",
  "gateway-security",
  "ces-security",
]);

const SECRET_TOKEN_PATTERN =
  /(?:^|[-_.])(?:keys?|secrets?|tokens?)(?:[-_.]|$)/i;

const QUERY_STOP_WORDS = new Set([
  "a",
  "about",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "can",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "this",
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

type WorkspaceRetrievalKind =
  | "lexical"
  | "path"
  | "section"
  | "structured-json";

interface WorkspaceBucket {
  name: string;
  relativePath: string | null;
  budget: number;
  rootFilesOnly?: boolean;
}

interface WorkspaceMatch {
  relativePath: string;
  excerpt: string;
  lineNumber: number;
  score: number;
  fileSizeBytes: number;
  matchedTerms: string[];
  retrieval: WorkspaceRetrievalKind;
  heading?: string;
}

interface WorkspacePathInspectionError {
  path: string;
  reason: string;
}

interface WorkspacePathInspectionResult {
  evidence: RecallEvidence[];
  errors: WorkspacePathInspectionError[];
}

interface WalkState {
  scannedFiles: number;
  visitedDirs: Set<string>;
  scannedRelativePaths: Set<string>;
}

export async function searchWorkspaceSource(
  query: string,
  context: RecallSearchContext,
  limit: number,
): Promise<RecallSearchResult> {
  const queryTerms = tokenizeQuery(query);
  const pathLiterals = extractWorkspacePathLiterals(query);
  if ((queryTerms.size === 0 && pathLiterals.length === 0) || limit <= 0) {
    return { evidence: [] };
  }

  const rootRealPath = await resolveRoot(context.workingDir);
  if (!rootRealPath) {
    return { evidence: [] };
  }

  const matches: WorkspaceMatch[] = [];
  const scannedRelativePaths = new Set<string>();

  for (const pathLiteral of pathLiterals) {
    const directMatches = await readWorkspaceFileMatches({
      relativePath: pathLiteral,
      rootRealPath,
      queryTerms,
      retrieval: "path",
      scoreBoost: 4,
    });
    matches.push(...directMatches);
    for (const match of directMatches) {
      scannedRelativePaths.add(match.relativePath);
    }
  }

  for (const bucket of WORKSPACE_BUCKETS) {
    const state: WalkState = {
      scannedFiles: 0,
      visitedDirs: new Set([rootRealPath]),
      scannedRelativePaths,
    };

    if (bucket.relativePath === null) {
      await scanOtherTopLevelEntries(rootRealPath, queryTerms, matches, state, {
        budget: bucket.budget,
        signal: context.signal,
      });
      continue;
    }

    const bucketPath = join(rootRealPath, bucket.relativePath);
    if (bucket.rootFilesOnly) {
      await scanRootFiles(rootRealPath, queryTerms, matches, state, {
        budget: bucket.budget,
        signal: context.signal,
      });
      continue;
    }

    const bucketRealPath = await resolveContainedPath(bucketPath, rootRealPath);
    if (!bucketRealPath) {
      continue;
    }

    await walkDirectory(
      bucketRealPath,
      rootRealPath,
      queryTerms,
      matches,
      state,
      {
        budget: bucket.budget,
        signal: context.signal,
      },
    );
  }

  const evidence = dedupeWorkspaceMatches(matches)
    .sort(compareWorkspaceMatches)
    .slice(0, limit)
    .map(toEvidence);

  return { evidence };
}

export async function inspectWorkspacePaths(
  paths: readonly string[],
  query: string,
  context: RecallSearchContext,
): Promise<WorkspacePathInspectionResult> {
  const rootRealPath = await resolveRoot(context.workingDir);
  if (!rootRealPath) {
    return {
      evidence: [],
      errors: paths.slice(0, WORKSPACE_INSPECT_MAX_PATHS).map((path) => ({
        path,
        reason: "workspace root is not a readable directory",
      })),
    };
  }

  const queryTerms = tokenizeQuery(query);
  const evidence: RecallEvidence[] = [];
  const errors: WorkspacePathInspectionError[] = [];

  for (const requestedPath of dedupeStrings(paths).slice(
    0,
    WORKSPACE_INSPECT_MAX_PATHS,
  )) {
    const relativePath = normalizeWorkspacePathLiteral(requestedPath);
    if (!relativePath || !isSafeWorkspaceRelativePath(relativePath)) {
      errors.push({
        path: requestedPath,
        reason: "path is not a safe relative workspace path",
      });
      continue;
    }

    const matches = await readWorkspaceFileMatches({
      relativePath,
      rootRealPath,
      queryTerms,
      retrieval: "path",
      scoreBoost: 4,
    });

    if (matches.length === 0) {
      errors.push({
        path: relativePath,
        reason: "path was missing, unreadable, too large, or had no text match",
      });
      continue;
    }

    evidence.push(...matches.slice(0, 1).map(toEvidence));
  }

  return { evidence, errors };
}

export function extractWorkspacePathLiterals(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(PATH_LITERAL_PATTERN)) {
    const rawPath = match[1];
    const normalizedPath = rawPath
      ? normalizeWorkspacePathLiteral(rawPath)
      : null;
    if (normalizedPath && isSafeWorkspaceRelativePath(normalizedPath)) {
      paths.push(normalizedPath);
    }
  }
  return dedupeStrings(paths);
}

export function isSafeWorkspaceRelativePath(relativePath: string): boolean {
  const normalizedPath = normalizeWorkspacePathLiteral(relativePath);
  if (
    !normalizedPath ||
    isAbsolute(normalizedPath) ||
    normalizedPath === "." ||
    normalizedPath.startsWith("../") ||
    normalizedPath.includes("/../")
  ) {
    return false;
  }

  const pathSegments = normalizedPath.split("/");
  return (
    !shouldSkipWorkspaceFile(normalizedPath) &&
    !shouldSkipFilePath(normalizedPath) &&
    !shouldSkipRelativePath(pathSegments)
  );
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

async function scanRootFiles(
  rootRealPath: string,
  queryTerms: ReadonlySet<string>,
  matches: WorkspaceMatch[],
  state: WalkState,
  options: { budget: number; signal: AbortSignal | undefined },
): Promise<void> {
  throwIfAborted(options.signal);

  let entries;
  try {
    entries = await readdir(rootRealPath, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    throwIfAborted(options.signal);
    if (state.scannedFiles >= options.budget) {
      return;
    }
    if (!entry.isFile()) {
      continue;
    }

    await maybeSearchFileEntry(
      rootRealPath,
      rootRealPath,
      entry.name,
      queryTerms,
      matches,
      state,
    );
  }
}

async function scanOtherTopLevelEntries(
  rootRealPath: string,
  queryTerms: ReadonlySet<string>,
  matches: WorkspaceMatch[],
  state: WalkState,
  options: { budget: number; signal: AbortSignal | undefined },
): Promise<void> {
  throwIfAborted(options.signal);

  let entries;
  try {
    entries = await readdir(rootRealPath, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    throwIfAborted(options.signal);
    if (state.scannedFiles >= options.budget) {
      return;
    }
    if (
      shouldSkipSegmentName(entry.name) ||
      KNOWN_BUCKET_TOP_LEVEL_DIRS.has(entry.name)
    ) {
      continue;
    }

    if (entry.isFile()) {
      await maybeSearchFileEntry(
        rootRealPath,
        rootRealPath,
        entry.name,
        queryTerms,
        matches,
        state,
      );
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    const entryPath = join(rootRealPath, entry.name);
    const entryRealPath = await resolveContainedPath(entryPath, rootRealPath);
    if (!entryRealPath || state.visitedDirs.has(entryRealPath)) {
      continue;
    }
    state.visitedDirs.add(entryRealPath);
    await walkDirectory(
      entryRealPath,
      rootRealPath,
      queryTerms,
      matches,
      state,
      {
        budget: options.budget,
        signal: options.signal,
      },
    );
  }
}

async function walkDirectory(
  directoryPath: string,
  rootRealPath: string,
  queryTerms: ReadonlySet<string>,
  matches: WorkspaceMatch[],
  state: WalkState,
  options: { budget: number; signal: AbortSignal | undefined },
): Promise<void> {
  throwIfAborted(options.signal);

  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) =>
    compareDirectoryEntries(rootRealPath, directoryPath, a, b),
  );

  for (const entry of entries) {
    throwIfAborted(options.signal);
    if (state.scannedFiles >= options.budget) {
      return;
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
      await walkDirectory(
        entryRealPath,
        rootRealPath,
        queryTerms,
        matches,
        state,
        {
          budget: options.budget,
          signal: options.signal,
        },
      );
      continue;
    }

    if (!entryStats.isFile()) {
      continue;
    }

    const lexicalRelativePath = toWorkspaceRelativePath(
      rootRealPath,
      entryPath,
    );
    await maybeSearchResolvedFile(
      entryRealPath,
      lexicalRelativePath,
      entryStats.size,
      queryTerms,
      matches,
      state,
    );
  }
}

async function maybeSearchFileEntry(
  rootRealPath: string,
  directoryPath: string,
  entryName: string,
  queryTerms: ReadonlySet<string>,
  matches: WorkspaceMatch[],
  state: WalkState,
): Promise<void> {
  const entryPath = join(directoryPath, entryName);
  const entryRealPath = await resolveContainedPath(entryPath, rootRealPath);
  if (!entryRealPath) {
    return;
  }

  let entryStats;
  try {
    entryStats = await stat(entryRealPath);
  } catch {
    return;
  }

  if (!entryStats.isFile()) {
    return;
  }

  await maybeSearchResolvedFile(
    entryRealPath,
    toWorkspaceRelativePath(rootRealPath, entryPath),
    entryStats.size,
    queryTerms,
    matches,
    state,
  );
}

async function maybeSearchResolvedFile(
  realPath: string,
  relativePath: string,
  fileSizeBytes: number,
  queryTerms: ReadonlySet<string>,
  matches: WorkspaceMatch[],
  state: WalkState,
): Promise<void> {
  if (state.scannedRelativePaths.has(relativePath)) {
    return;
  }
  state.scannedRelativePaths.add(relativePath);
  state.scannedFiles += 1;

  if (
    shouldSkipWorkspaceFile(relativePath) ||
    shouldSkipFilePath(relativePath) ||
    fileSizeBytes > WORKSPACE_SOURCE_MAX_FILE_SIZE_BYTES
  ) {
    return;
  }

  matches.push(
    ...(await searchFile(realPath, relativePath, fileSizeBytes, queryTerms)),
  );
}

async function readWorkspaceFileMatches(options: {
  relativePath: string;
  rootRealPath: string;
  queryTerms: ReadonlySet<string>;
  retrieval: WorkspaceRetrievalKind;
  scoreBoost: number;
}): Promise<WorkspaceMatch[]> {
  const normalizedPath = normalizeWorkspacePathLiteral(options.relativePath);
  if (!normalizedPath || !isSafeWorkspaceRelativePath(normalizedPath)) {
    return [];
  }

  const filePath = join(options.rootRealPath, normalizedPath);
  const fileRealPath = await resolveContainedPath(
    filePath,
    options.rootRealPath,
  );
  if (!fileRealPath) {
    return [];
  }

  let fileStats;
  try {
    fileStats = await stat(fileRealPath);
  } catch {
    return [];
  }

  if (
    !fileStats.isFile() ||
    fileStats.size > WORKSPACE_SOURCE_MAX_FILE_SIZE_BYTES
  ) {
    return [];
  }

  const matches = await searchFile(
    fileRealPath,
    normalizedPath,
    fileStats.size,
    options.queryTerms.size > 0
      ? options.queryTerms
      : tokenizeQuery(options.relativePath),
  );
  const fallbackMatches =
    matches.length === 0 && options.retrieval === "path"
      ? await readPathPreviewMatch(
          fileRealPath,
          normalizedPath,
          fileStats.size,
          options.queryTerms,
        )
      : [];

  return [...matches, ...fallbackMatches].slice(0, 1).map((match) => ({
    ...match,
    retrieval:
      match.retrieval === "structured-json"
        ? "structured-json"
        : options.retrieval,
    score: match.score + options.scoreBoost,
  }));
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
): Promise<WorkspaceMatch[]> {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const extension = extname(relativePath).toLowerCase();
  if (extension === ".json") {
    return searchJsonFile(contents, relativePath, fileSizeBytes, queryTerms);
  }
  if (extension === ".md") {
    const sectionMatches = searchMarkdownSections(
      contents,
      relativePath,
      fileSizeBytes,
      queryTerms,
    );
    if (sectionMatches.length > 0) {
      return sectionMatches;
    }
  }

  return searchLineMatches(contents, relativePath, fileSizeBytes, queryTerms);
}

async function readPathPreviewMatch(
  filePath: string,
  relativePath: string,
  fileSizeBytes: number,
  queryTerms: ReadonlySet<string>,
): Promise<WorkspaceMatch[]> {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const extension = extname(relativePath).toLowerCase();
  const retrieval: WorkspaceRetrievalKind =
    extension === ".json" ? "structured-json" : "path";
  const excerpt =
    extension === ".json"
      ? buildStructuredJsonExcerpt(contents)
      : buildFilePreviewExcerpt(contents);
  if (!excerpt) {
    return [];
  }

  const matchedTerms = termOverlap(
    tokenize(`${relativePath}\n${excerpt}`),
    queryTerms,
  );

  return [
    {
      relativePath,
      excerpt,
      lineNumber: 1,
      score: scoreMatch({
        relativePath,
        queryTerms,
        matchedTerms,
        retrieval,
        heading: undefined,
      }),
      fileSizeBytes,
      matchedTerms: [...matchedTerms].sort(),
      retrieval,
    },
  ];
}

function searchJsonFile(
  contents: string,
  relativePath: string,
  fileSizeBytes: number,
  queryTerms: ReadonlySet<string>,
): WorkspaceMatch[] {
  const textTerms = tokenize(contents);
  const matchedTerms = termOverlap(textTerms, queryTerms);
  if (matchedTerms.size === 0) {
    return [];
  }

  const excerpt = buildStructuredJsonExcerpt(contents);
  const score = scoreMatch({
    relativePath,
    queryTerms,
    matchedTerms,
    retrieval: "structured-json",
    heading: undefined,
  });

  return [
    {
      relativePath,
      excerpt,
      lineNumber: 1,
      score,
      fileSizeBytes,
      matchedTerms: [...matchedTerms].sort(),
      retrieval: "structured-json",
    },
  ];
}

function searchMarkdownSections(
  contents: string,
  relativePath: string,
  fileSizeBytes: number,
  queryTerms: ReadonlySet<string>,
): WorkspaceMatch[] {
  const lines = contents.split(/\r?\n/);
  const sections = parseMarkdownSections(lines);

  return sections
    .flatMap((section): WorkspaceMatch[] => {
      const sectionText = lines.slice(section.start, section.end).join("\n");
      const sectionTerms = tokenize(`${section.heading}\n${sectionText}`);
      const matchedTerms = termOverlap(sectionTerms, queryTerms);
      if (matchedTerms.size === 0) {
        return [];
      }

      return [
        {
          relativePath,
          excerpt: buildSectionExcerpt(lines, section.start, section.end),
          lineNumber: section.start + 1,
          score: scoreMatch({
            relativePath,
            queryTerms,
            matchedTerms,
            retrieval: "section",
            heading: section.heading,
          }),
          fileSizeBytes,
          matchedTerms: [...matchedTerms].sort(),
          retrieval: "section",
          heading: section.heading,
        },
      ];
    })
    .sort(compareWorkspaceMatches)
    .slice(0, MAX_SECTION_MATCHES_PER_FILE);
}

function searchLineMatches(
  contents: string,
  relativePath: string,
  fileSizeBytes: number,
  queryTerms: ReadonlySet<string>,
): WorkspaceMatch[] {
  const lines = contents.split(/\r?\n/);
  const bestLines = findBestLines(lines, queryTerms);
  return bestLines.map((bestLine) => ({
    relativePath,
    excerpt: buildExcerpt(lines, bestLine.lineIndex),
    lineNumber: bestLine.lineIndex + 1,
    score: scoreMatch({
      relativePath,
      queryTerms,
      matchedTerms: bestLine.matchedTerms,
      retrieval: "lexical",
      heading: undefined,
    }),
    fileSizeBytes,
    matchedTerms: [...bestLine.matchedTerms].sort(),
    retrieval: "lexical",
  }));
}

function findBestLines(
  lines: readonly string[],
  queryTerms: ReadonlySet<string>,
): Array<{ lineIndex: number; matchedTerms: Set<string> }> {
  return lines
    .flatMap((line, lineIndex) => {
      const lineTerms = tokenize(line);
      const matchedTerms = termOverlap(lineTerms, queryTerms);
      return matchedTerms.size > 0 ? [{ lineIndex, matchedTerms }] : [];
    })
    .sort((a, b) => b.matchedTerms.size - a.matchedTerms.size)
    .slice(0, MAX_LINE_MATCHES_PER_FILE);
}

function parseMarkdownSections(
  lines: readonly string[],
): Array<{ heading: string; start: number; end: number }> {
  const headingIndexes = lines.flatMap((line, index) => {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    return heading ? [{ index, heading: heading[2] ?? "" }] : [];
  });

  if (headingIndexes.length === 0) {
    return [];
  }

  return headingIndexes.map((heading, index) => ({
    heading: heading.heading,
    start: heading.index,
    end: headingIndexes[index + 1]?.index ?? lines.length,
  }));
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

function buildSectionExcerpt(
  lines: readonly string[],
  start: number,
  end: number,
): string {
  const excerpt = lines
    .slice(start, end)
    .map((line, offset) => `${start + offset + 1}: ${line.trimEnd()}`)
    .join("\n")
    .trim();

  if (excerpt.length <= SECTION_EXCERPT_MAX_CHARS) {
    return excerpt;
  }

  return `${excerpt.slice(0, SECTION_EXCERPT_MAX_CHARS - 3).trimEnd()}...`;
}

function buildStructuredJsonExcerpt(contents: string): string {
  try {
    const parsed = JSON.parse(contents) as unknown;
    const compact = summarizeJsonValue(parsed);
    return truncateExcerpt(
      JSON.stringify(compact, null, 2),
      STRUCTURED_JSON_EXCERPT_MAX_CHARS,
    );
  } catch {
    return truncateExcerpt(contents.trim(), STRUCTURED_JSON_EXCERPT_MAX_CHARS);
  }
}

function buildFilePreviewExcerpt(contents: string): string {
  const lines = contents.split(/\r?\n/).slice(0, 40);
  const excerpt = lines
    .map((line, offset) => `${offset + 1}: ${line.trimEnd()}`)
    .join("\n")
    .trim();
  return truncateExcerpt(excerpt, SECTION_EXCERPT_MAX_CHARS);
}

function summarizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(summarizeJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>).slice(0, 30);
  return Object.fromEntries(
    entries.map(([key, entryValue]) => {
      if (
        entryValue &&
        typeof entryValue === "object" &&
        !Array.isArray(entryValue)
      ) {
        const record = entryValue as Record<string, unknown>;
        const preferredKeys = [
          "name",
          "description",
          "dirName",
          "notes",
          "lat",
          "lon",
          "radius_m",
          "emoji",
          "id",
          "createdAt",
          "updatedAt",
        ];
        const summary = Object.fromEntries(
          preferredKeys
            .filter((preferredKey) => preferredKey in record)
            .map((preferredKey) => [preferredKey, record[preferredKey]]),
        );
        return [
          key,
          Object.keys(summary).length > 0
            ? summary
            : summarizeJsonValue(record),
        ];
      }
      return [key, summarizeJsonValue(entryValue)];
    }),
  );
}

function truncateExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function scoreMatch(options: {
  relativePath: string;
  queryTerms: ReadonlySet<string>;
  matchedTerms: ReadonlySet<string>;
  retrieval: WorkspaceRetrievalKind;
  heading: string | undefined;
}): number {
  const pathTerms = termOverlap(
    tokenize(options.relativePath),
    options.queryTerms,
  );
  const headingTerms = termOverlap(
    tokenize(options.heading ?? ""),
    options.queryTerms,
  );
  const retrievalBoost =
    options.retrieval === "path"
      ? 4
      : options.retrieval === "structured-json"
        ? 0.4
        : options.retrieval === "section"
          ? 1.1
          : 0;
  return (
    retrievalBoost +
    getPathPriorityBoost(options.relativePath) +
    options.matchedTerms.size / Math.max(options.queryTerms.size, 1) +
    pathTerms.size * 0.08 +
    headingTerms.size * 0.12
  );
}

function getPathPriorityBoost(relativePath: string): number {
  if (relativePath.startsWith("data/apps/")) return 0.65;
  if (relativePath.startsWith("scratch/location-tracker/")) return 0.65;
  if (relativePath.startsWith("work/")) return 0.45;
  if (relativePath.startsWith("scratch/")) return 0.35;
  if (relativePath.startsWith("users/")) return 0.3;
  if (relativePath.startsWith("journal/")) return 0.25;
  if (relativePath.startsWith("pkb/archive/")) return -0.15;
  if (relativePath.startsWith("pkb/")) return 0.2;
  if (relativePath.startsWith("memory/concepts/")) return 0.4;
  if (relativePath.startsWith("memory/")) return 0.2;
  if (
    relativePath.startsWith("conversations/") ||
    relativePath.startsWith("backups/") ||
    relativePath.startsWith("logs/")
  ) {
    return -0.3;
  }
  return 0;
}

function toEvidence(match: WorkspaceMatch): RecallEvidence {
  return {
    id: `workspace:${match.relativePath}:${match.lineNumber}:${match.retrieval}`,
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
      retrieval: match.retrieval,
      ...(match.heading ? { heading: match.heading } : {}),
    },
  };
}

function dedupeWorkspaceMatches(
  matches: readonly WorkspaceMatch[],
): WorkspaceMatch[] {
  const seen = new Set<string>();
  const deduped: WorkspaceMatch[] = [];
  for (const match of matches) {
    const key = [
      match.relativePath,
      match.lineNumber,
      match.retrieval,
      normalizeExcerptForDedupe(match.excerpt),
    ].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(match);
  }
  return deduped;
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
  const bucketIndex = WORKSPACE_BUCKETS.findIndex((bucket) => {
    if (!bucket.relativePath) return false;
    return (
      bucket.relativePath.split("/")[0]?.toLowerCase() === lowerFirstSegment
    );
  });
  return bucketIndex >= 0 ? bucketIndex + 1 : 99;
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
    SECRET_TOKEN_PATTERN.test(lowerName) ||
    lowerName.startsWith("credentials") ||
    SECRET_SEGMENT_NAMES.has(lowerName)
  );
}

function normalizeWorkspacePathLiteral(pathLiteral: string): string | null {
  const trimmed = pathLiteral
    .trim()
    .replace(/^["'`]+|["'`.,;:)>\]}]+$/g, "")
    .replace(/^\.\//, "");
  const withoutLineSuffix = trimmed.replace(/(\.[A-Za-z0-9]+):\d+$/, "$1");
  if (!withoutLineSuffix || withoutLineSuffix.startsWith("~")) {
    return null;
  }
  return withoutLineSuffix.split(sep).join("/");
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

function tokenizeQuery(text: string): Set<string> {
  const terms = [...tokenize(text)].filter(
    (term) => term.length >= 2 && !QUERY_STOP_WORDS.has(term),
  );
  return new Set(terms);
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

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeExcerptForDedupe(excerpt: string): string {
  return excerpt.trim().replace(/\s+/g, " ").toLowerCase();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Workspace recall search aborted");
  }
}
