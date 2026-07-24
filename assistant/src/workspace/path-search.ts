import type { Dirent } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { getWorkspaceDir } from "../util/platform.js";

const DEFAULT_RESULT_LIMIT = 100;
const MAX_CATALOG_ENTRIES = 50_000;
// Checked between filesystem awaits; Node cannot cancel an in-flight fs syscall.
const MAX_CATALOG_BUILD_MS = 2_000;
const CATALOG_TTL_MS = 3_000;

const PRUNED_DIRECTORY_NAMES = new Set([
  ".build",
  ".cache",
  ".git",
  ".gradle",
  ".hg",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".svelte-kit",
  ".svn",
  ".terraform",
  ".turbo",
  ".venv",
  "__pycache__",
  "browser-profile",
  "build",
  "coverage",
  "deriveddata",
  "dist",
  "embedding-models",
  "node_modules",
  "pods",
  "target",
  "venv",
]);

const PRUNED_ROOT_DIRECTORIES = new Set([
  "bin",
  "external",
  "logs",
  "plugins-data",
]);
const PRUNED_RELATIVE_DIRECTORIES = new Set([
  "data/db",
  "data/monitoring",
  "data/qdrant",
]);

export type WorkspacePathEntryType = "file" | "directory";

export interface WorkspacePathEntry {
  name: string;
  path: string;
  type: WorkspacePathEntryType;
}

export type WorkspacePathSearchTruncationReason =
  | "result_limit"
  | "entry_limit"
  | "time_limit"
  | "io_error";

export interface WorkspacePathSearchResult {
  results: WorkspacePathEntry[];
  truncated: boolean;
  truncatedReason: WorkspacePathSearchTruncationReason | null;
}

interface CatalogSnapshot {
  entries: IndexedWorkspacePathEntry[];
  truncatedReason: Exclude<
    WorkspacePathSearchTruncationReason,
    "result_limit"
  > | null;
}

interface IndexedWorkspacePathEntry {
  entry: WorkspacePathEntry;
  normalizedName: string;
  normalizedPath: string;
  depth: number;
}

interface QueuedDirectory {
  absolutePath: string;
  relativePath: string;
}

type OpenDirectory = (
  path: string,
  signal: AbortSignal,
) => AsyncIterable<Dirent>;

interface WorkspacePathCatalogOptions {
  getRootPath?: () => string;
  openDirectory?: OpenDirectory;
  now?: () => number;
  cacheTtlMs?: number;
  maxEntries?: number;
  maxBuildMs?: number;
}

interface SearchOptions {
  query: string;
  limit?: number;
  showHidden?: boolean;
  signal?: AbortSignal;
}

interface CachedSnapshot {
  snapshot: CatalogSnapshot;
  expiresAt: number;
}

interface InFlightBuild {
  controller: AbortController;
  promise: Promise<CatalogSnapshot>;
  settled: boolean;
  waiters: number;
}

interface RankedEntry {
  entry: WorkspacePathEntry;
  tier: number;
  depth: number;
  normalizedPath: string;
}

async function* openDirectoryEntries(
  path: string,
  signal: AbortSignal,
): AsyncIterable<Dirent> {
  throwIfAborted(signal);
  const directory = await opendir(path);
  for await (const entry of directory) {
    throwIfAborted(signal);
    yield entry;
  }
}

function createAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) {
    return promise;
  }
  const abortSignal = signal;

  return new Promise<T>((resolve, reject) => {
    function cleanup() {
      abortSignal.removeEventListener("abort", handleAbort);
    }
    function handleAbort() {
      cleanup();
      reject(createAbortError(abortSignal));
    }
    abortSignal.addEventListener("abort", handleAbort, { once: true });
    if (abortSignal.aborted) {
      handleAbort();
      return;
    }
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isPathContained(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function shouldPruneDirectory(name: string, relativePath: string): boolean {
  const normalizedName = name.toLowerCase();
  const normalizedPath = relativePath.toLowerCase();
  if (PRUNED_DIRECTORY_NAMES.has(normalizedName)) {
    return true;
  }
  if (
    !normalizedPath.includes("/") &&
    PRUNED_ROOT_DIRECTORIES.has(normalizedName)
  ) {
    return true;
  }
  if (PRUNED_RELATIVE_DIRECTORIES.has(normalizedPath)) {
    return true;
  }
  return /^data\/apps\/[^/]+\/records$/.test(normalizedPath);
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").replaceAll("\\", "/").toLowerCase();
}

function indexWorkspacePathEntry(
  entry: WorkspacePathEntry,
): IndexedWorkspacePathEntry {
  return {
    entry,
    normalizedName: normalizeSearchText(entry.name),
    normalizedPath: normalizeSearchText(entry.path),
    depth: entry.path.split("/").length,
  };
}

function rankEntry(
  indexedEntry: IndexedWorkspacePathEntry,
  normalizedQuery: string,
): RankedEntry | undefined {
  const { entry, normalizedName, normalizedPath, depth } = indexedEntry;

  let tier: number;
  if (normalizedName === normalizedQuery) {
    tier = 0;
  } else if (normalizedName.startsWith(normalizedQuery)) {
    tier = 1;
  } else if (normalizedName.includes(normalizedQuery)) {
    tier = 2;
  } else if (
    normalizedQuery.includes("/") &&
    normalizedPath.includes(normalizedQuery)
  ) {
    tier = 3;
  } else {
    return undefined;
  }

  return {
    entry,
    tier,
    depth,
    normalizedPath,
  };
}

function compareRankedEntries(a: RankedEntry, b: RankedEntry): number {
  if (a.tier !== b.tier) {
    return a.tier - b.tier;
  }
  if (a.depth !== b.depth) {
    return a.depth - b.depth;
  }
  if (a.entry.path.length !== b.entry.path.length) {
    return a.entry.path.length - b.entry.path.length;
  }
  if (a.entry.type !== b.entry.type) {
    return a.entry.type === "directory" ? -1 : 1;
  }
  if (a.normalizedPath !== b.normalizedPath) {
    return a.normalizedPath < b.normalizedPath ? -1 : 1;
  }
  if (a.entry.path === b.entry.path) {
    return 0;
  }
  return a.entry.path < b.entry.path ? -1 : 1;
}

function insertRankedEntry(
  ranked: RankedEntry[],
  candidate: RankedEntry,
  limit: number,
): void {
  if (
    ranked.length === limit &&
    compareRankedEntries(candidate, ranked[ranked.length - 1]) >= 0
  ) {
    return;
  }

  let low = 0;
  let high = ranked.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareRankedEntries(candidate, ranked[middle]) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  ranked.splice(low, 0, candidate);
  if (ranked.length > limit) {
    ranked.pop();
  }
}

function searchIndexedWorkspacePathEntries(
  entries: readonly IndexedWorkspacePathEntry[],
  query: string,
  limit = DEFAULT_RESULT_LIMIT,
  catalogTruncationReason: CatalogSnapshot["truncatedReason"] = null,
): WorkspacePathSearchResult {
  if (limit < 1) {
    throw new RangeError("Search result limit must be positive");
  }

  const normalizedQuery = normalizeSearchText(query.trim());
  const ranked: RankedEntry[] = [];
  let matchCount = 0;

  for (const entry of entries) {
    const match = rankEntry(entry, normalizedQuery);
    if (match) {
      matchCount += 1;
      insertRankedEntry(ranked, match, limit);
    }
  }

  const resultLimitHit = matchCount > limit;
  return {
    results: ranked.map(({ entry }) => entry),
    truncated: catalogTruncationReason !== null || resultLimitHit,
    truncatedReason:
      catalogTruncationReason ?? (resultLimitHit ? "result_limit" : null),
  };
}

export function searchWorkspacePathEntries(
  entries: readonly WorkspacePathEntry[],
  query: string,
  limit = DEFAULT_RESULT_LIMIT,
  catalogTruncationReason: CatalogSnapshot["truncatedReason"] = null,
): WorkspacePathSearchResult {
  return searchIndexedWorkspacePathEntries(
    entries.map(indexWorkspacePathEntry),
    query,
    limit,
    catalogTruncationReason,
  );
}

export class WorkspacePathCatalog {
  private readonly getRootPath: () => string;
  private readonly openDirectory: OpenDirectory;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxBuildMs: number;
  private readonly cache = new Map<string, CachedSnapshot>();
  private readonly inFlight = new Map<string, InFlightBuild>();
  private generation = 0;

  constructor(options: WorkspacePathCatalogOptions = {}) {
    this.getRootPath = options.getRootPath ?? getWorkspaceDir;
    this.openDirectory = options.openDirectory ?? openDirectoryEntries;
    this.now = options.now ?? (() => performance.now());
    this.cacheTtlMs = options.cacheTtlMs ?? CATALOG_TTL_MS;
    this.maxEntries = options.maxEntries ?? MAX_CATALOG_ENTRIES;
    this.maxBuildMs = options.maxBuildMs ?? MAX_CATALOG_BUILD_MS;
  }

  async search(options: SearchOptions): Promise<WorkspacePathSearchResult> {
    const snapshot = await this.getSnapshot(
      options.showHidden ?? false,
      options.signal,
    );
    throwIfAborted(options.signal);
    return searchIndexedWorkspacePathEntries(
      snapshot.entries,
      options.query,
      options.limit,
      snapshot.truncatedReason,
    );
  }

  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
    for (const build of this.inFlight.values()) {
      build.controller.abort();
    }
    this.inFlight.clear();
  }

  private async getSnapshot(
    showHidden: boolean,
    signal?: AbortSignal,
  ): Promise<CatalogSnapshot> {
    throwIfAborted(signal);
    const rootPath = this.getRootPath();
    const key = `${rootPath}\0${showHidden}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return cached.snapshot;
    }
    this.cache.delete(key);

    let build = this.inFlight.get(key);
    if (build?.controller.signal.aborted) {
      this.inFlight.delete(key);
      build = undefined;
    }
    if (!build) {
      build = this.startBuild(key, rootPath, showHidden);
    }

    build.waiters += 1;
    try {
      return await awaitWithAbort(build.promise, signal);
    } finally {
      build.waiters -= 1;
      if (!build.settled && build.waiters === 0) {
        build.controller.abort();
      }
    }
  }

  private startBuild(
    key: string,
    rootPath: string,
    showHidden: boolean,
  ): InFlightBuild {
    const controller = new AbortController();
    const generation = this.generation;
    const build = {
      controller,
      promise: Promise.resolve({} as CatalogSnapshot),
      settled: false,
      waiters: 0,
    };

    build.promise = this.buildSnapshot(rootPath, showHidden, controller.signal)
      .then((snapshot) => {
        if (generation === this.generation) {
          this.cache.set(key, {
            snapshot,
            expiresAt: this.now() + this.cacheTtlMs,
          });
        }
        return snapshot;
      })
      .finally(() => {
        build.settled = true;
        if (this.inFlight.get(key) === build) {
          this.inFlight.delete(key);
        }
      });
    void build.promise.catch(() => undefined);
    this.inFlight.set(key, build);
    return build;
  }

  private async buildSnapshot(
    rootPath: string,
    showHidden: boolean,
    signal: AbortSignal,
  ): Promise<CatalogSnapshot> {
    throwIfAborted(signal);
    const rootRealPath = await realpath(rootPath);
    const rootStats = await lstat(rootRealPath);
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root is not a directory: ${rootPath}`);
    }

    const startedAt = this.now();
    const entries: IndexedWorkspacePathEntry[] = [];
    const pendingDirectories: QueuedDirectory[] = [
      { absolutePath: rootRealPath, relativePath: "" },
    ];
    const visitedDirectories = new Set<string>();
    let pendingIndex = 0;
    let visitedEntries = 0;
    let hadIoError = false;
    let truncationReason: CatalogSnapshot["truncatedReason"] = null;

    while (pendingIndex < pendingDirectories.length && !truncationReason) {
      throwIfAborted(signal);
      if (this.now() - startedAt >= this.maxBuildMs) {
        truncationReason = "time_limit";
        break;
      }

      const current = pendingDirectories[pendingIndex];
      pendingIndex += 1;

      let currentRealPath: string;
      try {
        const stats = await lstat(current.absolutePath);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          continue;
        }
        currentRealPath = await realpath(current.absolutePath);
      } catch (error) {
        if (current.relativePath === "") {
          throw error;
        }
        hadIoError = true;
        continue;
      }

      if (
        !isPathContained(rootRealPath, currentRealPath) ||
        visitedDirectories.has(currentRealPath)
      ) {
        continue;
      }
      visitedDirectories.add(currentRealPath);

      try {
        for await (const entry of this.openDirectory(currentRealPath, signal)) {
          throwIfAborted(signal);
          if (this.now() - startedAt >= this.maxBuildMs) {
            truncationReason = "time_limit";
            break;
          }
          if (visitedEntries >= this.maxEntries) {
            truncationReason = "entry_limit";
            break;
          }
          visitedEntries += 1;
          if (!showHidden && entry.name.startsWith(".")) {
            continue;
          }

          const absolutePath = join(currentRealPath, entry.name);
          let type: WorkspacePathEntryType | undefined;
          if (entry.isDirectory()) {
            type = "directory";
          } else if (entry.isFile()) {
            type = "file";
          } else if (!entry.isSymbolicLink()) {
            try {
              const stats = await lstat(absolutePath);
              if (stats.isDirectory()) {
                type = "directory";
              } else if (stats.isFile()) {
                type = "file";
              }
            } catch {
              hadIoError = true;
              continue;
            }
          }
          if (!type) {
            continue;
          }

          const relativePath = current.relativePath
            ? `${current.relativePath}/${entry.name}`
            : entry.name;
          entries.push(
            indexWorkspacePathEntry({
              name: entry.name,
              path: relativePath,
              type,
            }),
          );

          if (
            type === "directory" &&
            !shouldPruneDirectory(entry.name, relativePath)
          ) {
            pendingDirectories.push({
              absolutePath,
              relativePath,
            });
          }
        }
      } catch (error) {
        throwIfAborted(signal);
        if (current.relativePath === "") {
          throw error;
        }
        hadIoError = true;
      }
    }

    return {
      entries,
      truncatedReason: truncationReason ?? (hadIoError ? "io_error" : null),
    };
  }
}

export const workspacePathCatalog = new WorkspacePathCatalog();
