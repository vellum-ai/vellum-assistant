import type { Dirent } from "node:fs";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";

import {
  searchWorkspacePathEntries,
  WorkspacePathCatalog,
  type WorkspacePathEntry,
} from "./path-search.js";

const testWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR!;
const fixtureRoot = join(testWorkspaceDir, "path-search-fixture");
const outsideRoot = join(testWorkspaceDir, "path-search-outside");

async function* readDirectory(
  path: string,
  signal: AbortSignal,
): AsyncIterable<Dirent> {
  signal.throwIfAborted();
  const directory = await opendir(path);
  for await (const entry of directory) {
    signal.throwIfAborted();
    yield entry;
  }
}

function createCatalog(
  rootPath: string,
  overrides: ConstructorParameters<typeof WorkspacePathCatalog>[0] = {},
): WorkspacePathCatalog {
  return new WorkspacePathCatalog({
    getRootPath: () => rootPath,
    cacheTtlMs: 3_000,
    maxBuildMs: 10_000,
    ...overrides,
  });
}

beforeAll(() => {
  mkdirSync(join(fixtureRoot, "normal"), { recursive: true });
  mkdirSync(join(fixtureRoot, "AgentWatch"), { recursive: true });
  mkdirSync(join(fixtureRoot, ".notes"), { recursive: true });
  mkdirSync(join(fixtureRoot, "NODE_MODULES", "dep"), { recursive: true });
  mkdirSync(join(fixtureRoot, "BuIlD"), { recursive: true });
  mkdirSync(join(fixtureRoot, ".Hg", "store"), { recursive: true });
  mkdirSync(join(fixtureRoot, "logs"), { recursive: true });
  mkdirSync(join(fixtureRoot, "unreadable"), { recursive: true });
  mkdirSync(join(fixtureRoot, "vendor"), { recursive: true });
  mkdirSync(join(fixtureRoot, "real"), { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });

  writeFileSync(join(fixtureRoot, "normal", "agentwatch-client.ts"), "");
  writeFileSync(join(fixtureRoot, "AgentWatch", "readme.md"), "");
  writeFileSync(join(fixtureRoot, ".notes", "hidden-agentwatch.md"), "");
  writeFileSync(
    join(fixtureRoot, "NODE_MODULES", "dep", "dependency-sentinel.ts"),
    "",
  );
  writeFileSync(join(fixtureRoot, "BuIlD", "build-sentinel.js"), "");
  writeFileSync(join(fixtureRoot, ".Hg", "store", "vcs-sentinel"), "");
  writeFileSync(join(fixtureRoot, "logs", "runtime-sentinel.log"), "");
  writeFileSync(join(fixtureRoot, "unreadable", "io-sentinel.txt"), "");
  writeFileSync(join(fixtureRoot, "vendor", "vendor-sentinel.ts"), "");
  writeFileSync(join(fixtureRoot, "real", "real-target.ts"), "");
  writeFileSync(join(outsideRoot, "outside-target.ts"), "");

  symlinkSync("real", join(fixtureRoot, "alias"));
  symlinkSync(".", join(fixtureRoot, "loop"));
  symlinkSync(outsideRoot, join(fixtureRoot, "outside-link"));
  symlinkSync("missing", join(fixtureRoot, "broken-link"));
});

describe("WorkspacePathCatalog traversal", () => {
  test("finds case-insensitive nested file and directory matches", async () => {
    const result = await createCatalog(fixtureRoot).search({
      query: "AGENTWATCH",
      limit: 20,
    });

    expect(result.results.map((entry) => entry.path)).toEqual([
      "AgentWatch",
      "normal/agentwatch-client.ts",
    ]);
    expect(result.truncated).toBe(false);
    expect(result.truncatedReason).toBeNull();
  });

  test("returns pruned directories without descending into them", async () => {
    const openedDirectories: string[] = [];
    const catalog = createCatalog(fixtureRoot, {
      openDirectory: async function* (path, signal) {
        openedDirectories.push(path);
        yield* readDirectory(path, signal);
      },
    });

    const directoryResult = await catalog.search({
      query: "node_modules",
      limit: 20,
    });
    const childResult = await catalog.search({
      query: "dependency-sentinel",
      limit: 20,
    });

    expect(directoryResult.results.map((entry) => entry.path)).toEqual([
      "NODE_MODULES",
    ]);
    expect(childResult.results).toEqual([]);
    expect(
      openedDirectories.some((path) => path.includes("NODE_MODULES")),
    ).toBe(false);
    expect(openedDirectories.some((path) => path.includes("BuIlD"))).toBe(
      false,
    );
    expect(openedDirectories.some((path) => path.endsWith("/logs"))).toBe(
      false,
    );
  });

  test("keeps generic vendor directories searchable", async () => {
    const result = await createCatalog(fixtureRoot).search({
      query: "vendor-sentinel",
      limit: 20,
    });

    expect(result.results.map((entry) => entry.path)).toEqual([
      "vendor/vendor-sentinel.ts",
    ]);
  });

  test("includes hidden paths only when requested", async () => {
    const catalog = createCatalog(fixtureRoot);

    const hiddenOff = await catalog.search({
      query: "hidden-agentwatch",
      limit: 20,
    });
    const hiddenOn = await catalog.search({
      query: "hidden-agentwatch",
      limit: 20,
      showHidden: true,
    });

    expect(hiddenOff.results).toEqual([]);
    expect(hiddenOn.results.map((entry) => entry.path)).toEqual([
      ".notes/hidden-agentwatch.md",
    ]);
  });

  test("never follows or returns symbolic links", async () => {
    const result = await createCatalog(fixtureRoot).search({
      query: "target",
      limit: 20,
    });
    const linkResult = await createCatalog(fixtureRoot).search({
      query: "link",
      limit: 20,
    });

    expect(result.results.map((entry) => entry.path)).toEqual([
      "real/real-target.ts",
    ]);
    expect(linkResult.results).toEqual([]);
    expect(
      result.results.some((entry) => entry.path.startsWith("alias/")),
    ).toBe(false);
    expect(
      result.results.some((entry) => entry.path.startsWith("outside-link/")),
    ).toBe(false);
  });

  test("falls back to lstat for entries with unknown directory types", async () => {
    const root = join(testWorkspaceDir, "path-search-unknown-dirent");
    const filename = "unknown-entry.txt";
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, filename), "");

    const unknownEntry = {
      name: filename,
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => false,
    } as unknown as Dirent;
    const result = await createCatalog(root, {
      openDirectory: async function* () {
        yield unknownEntry;
      },
    }).search({ query: "unknown-entry", limit: 20 });

    expect(result.results).toEqual([
      { name: filename, path: filename, type: "file" },
    ]);
  });

  test("reports incomplete results when a child directory cannot be read", async () => {
    const result = await createCatalog(fixtureRoot, {
      openDirectory: async function* (path, signal) {
        if (path === join(fixtureRoot, "unreadable")) {
          throw new Error("simulated I/O failure");
        }
        yield* readDirectory(path, signal);
      },
    }).search({ query: "io-sentinel", limit: 20 });

    expect(result.results).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe("io_error");
  });

  test("reports an entry-budget truncation without traversing indefinitely", async () => {
    const root = join(testWorkspaceDir, "path-search-entry-budget");
    mkdirSync(root, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      writeFileSync(join(root, `match-${index}.txt`), "");
    }

    const result = await createCatalog(root, { maxEntries: 2 }).search({
      query: "match",
      limit: 20,
    });

    expect(result.results).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe("entry_limit");
  });

  test("reports time-budget truncation using a monotonic clock", async () => {
    let tick = 0;
    const result = await createCatalog(fixtureRoot, {
      maxBuildMs: 2,
      now: () => tick++,
    }).search({
      query: "does-not-exist",
      limit: 20,
    });

    expect(result.results).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe("time_limit");
  });
});

describe("WorkspacePathCatalog caching and cancellation", () => {
  test("reuses a completed catalog until its TTL expires", async () => {
    const root = join(testWorkspaceDir, "path-search-cache");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "first.txt"), "");

    let now = 0;
    let openCount = 0;
    const catalog = createCatalog(root, {
      now: () => now,
      openDirectory: async function* (path, signal) {
        openCount += 1;
        yield* readDirectory(path, signal);
      },
    });

    await catalog.search({ query: "first", limit: 20 });
    await catalog.search({ query: "missing", limit: 20 });
    expect(openCount).toBe(1);

    writeFileSync(join(root, "second.txt"), "");
    const cached = await catalog.search({ query: "second", limit: 20 });
    expect(cached.results).toEqual([]);

    now = 3_001;
    const rebuilt = await catalog.search({ query: "second", limit: 20 });
    expect(rebuilt.results.map((entry) => entry.path)).toEqual(["second.txt"]);
    expect(openCount).toBe(2);
  });

  test("explicit invalidation makes filesystem changes visible", async () => {
    const root = join(testWorkspaceDir, "path-search-invalidation");
    mkdirSync(root, { recursive: true });
    const catalog = createCatalog(root);

    await catalog.search({ query: "new-file", limit: 20 });
    writeFileSync(join(root, "new-file.txt"), "");
    expect(
      (await catalog.search({ query: "new-file", limit: 20 })).results,
    ).toEqual([]);

    catalog.invalidate();
    expect(
      (await catalog.search({ query: "new-file", limit: 20 })).results.map(
        (entry) => entry.path,
      ),
    ).toEqual(["new-file.txt"]);
  });

  test("rejects an already-aborted request before opening the filesystem", async () => {
    let openCount = 0;
    const catalog = createCatalog(fixtureRoot, {
      openDirectory: async function* (path, signal) {
        openCount += 1;
        yield* readDirectory(path, signal);
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      catalog.search({
        query: "agentwatch",
        limit: 20,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(openCount).toBe(0);
  });

  test("one cancelled waiter does not cancel a shared catalog build", async () => {
    let releaseBuild: (() => void) | undefined;
    let markBuildStarted: (() => void) | undefined;
    const buildStarted = new Promise<void>((resolve) => {
      markBuildStarted = resolve;
    });
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const catalog = createCatalog(fixtureRoot, {
      openDirectory: async function* (path, signal) {
        markBuildStarted?.();
        await buildGate;
        yield* readDirectory(path, signal);
      },
    });
    const cancelledController = new AbortController();

    const cancelledSearch = catalog.search({
      query: "agentwatch",
      limit: 20,
      signal: cancelledController.signal,
    });
    const activeSearch = catalog.search({
      query: "agentwatch",
      limit: 20,
    });
    await buildStarted;
    cancelledController.abort();
    releaseBuild?.();

    await expect(cancelledSearch).rejects.toMatchObject({ name: "AbortError" });
    expect((await activeSearch).results.length).toBeGreaterThan(0);
  });

  test("invalidation transparently refreshes an active catalog build", async () => {
    const root = join(testWorkspaceDir, "path-search-active-invalidation");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "existing.txt"), "");

    let firstBuild = true;
    let staleBuildAborted = false;
    let markBuildStarted: (() => void) | undefined;
    const buildStarted = new Promise<void>((resolve) => {
      markBuildStarted = resolve;
    });
    const catalog = createCatalog(root, {
      openDirectory: async function* (path, signal) {
        if (firstBuild) {
          firstBuild = false;
          markBuildStarted?.();
          await new Promise<void>((_, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                staleBuildAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        }
        yield* readDirectory(path, signal);
      },
    });

    const staleSearch = catalog.search({ query: "added", limit: 20 });
    await buildStarted;
    writeFileSync(join(root, "added.txt"), "");
    catalog.invalidate();
    const freshSearch = catalog.search({ query: "added", limit: 20 });

    expect(staleBuildAborted).toBe(true);
    expect((await staleSearch).results.map((entry) => entry.path)).toEqual([
      "added.txt",
    ]);
    expect((await freshSearch).results.map((entry) => entry.path)).toEqual([
      "added.txt",
    ]);
  });
});

describe("searchWorkspacePathEntries ranking", () => {
  const entries: WorkspacePathEntry[] = [
    {
      name: "readme.md",
      path: "docs/agentwatch/readme.md",
      type: "file",
    },
    {
      name: "my-agentwatch-notes.md",
      path: "notes/my-agentwatch-notes.md",
      type: "file",
    },
    {
      name: "agentwatch-client.ts",
      path: "src/agentwatch-client.ts",
      type: "file",
    },
    {
      name: "agentwatch",
      path: "agentwatch",
      type: "directory",
    },
  ];

  test("orders exact, prefix, then basename substring matches", () => {
    const result = searchWorkspacePathEntries(entries, "AgentWatch", 20);

    expect(result.results.map((entry) => entry.path)).toEqual([
      "agentwatch",
      "src/agentwatch-client.ts",
      "notes/my-agentwatch-notes.md",
    ]);
  });

  test("matches parent paths only for path-shaped queries", () => {
    const result = searchWorkspacePathEntries(entries, "docs/AgentWatch", 20);

    expect(result.results.map((entry) => entry.path)).toEqual([
      "docs/agentwatch/readme.md",
    ]);
  });

  test("uses deterministic shallow and short-path tie breakers", () => {
    const result = searchWorkspacePathEntries(
      [
        { name: "match.txt", path: "deep/path/match.txt", type: "file" },
        { name: "match.txt", path: "wide/match.txt", type: "file" },
        { name: "match.txt", path: "match.txt", type: "file" },
      ],
      "match",
      20,
    );

    expect(result.results.map((entry) => entry.path)).toEqual([
      "match.txt",
      "wide/match.txt",
      "deep/path/match.txt",
    ]);
  });

  test("distinguishes result limits from catalog truncation", () => {
    const complete = searchWorkspacePathEntries(entries, "agentwatch", 3);
    const limited = searchWorkspacePathEntries(entries, "agentwatch", 2);
    const catalogLimited = searchWorkspacePathEntries(
      entries,
      "agentwatch",
      2,
      "entry_limit",
    );

    expect(complete.truncatedReason).toBeNull();
    expect(limited.truncatedReason).toBe("result_limit");
    expect(catalogLimited.truncatedReason).toBe("entry_limit");
  });
});
