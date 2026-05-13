/**
 * Tests for the `assistant changelog` CLI command.
 *
 * Every test exercises the public CLI surface via `runCli`. Internal helpers
 * (cache plumbing, version compare, rendering) are validated through the
 * commands that exercise them, not via module-level test exports.
 *
 * Coverage:
 *   - Default action (latest stable, --since, --json).
 *   - `show <version>` (renders, --json, 404, persists to cache).
 *   - `list` (rows, --json, --limit/--no-cache propagation).
 *   - Cache behavior (fresh cache short-circuits fetch; --no-cache bypass;
 *     stale TTL refetch; cache capped at CACHE_STABLE_LIMIT stable
 *     releases; pagination buffer absorbs drafts/prereleases).
 *   - Error mapping (rate-limit → friendly stderr; non-zero exit).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { Command } from "commander";

// ── Mocks ────────────────────────────────────────────────────────────

const TMP_ROOT = mkdtempSync(join(tmpdir(), "changelog-test-"));

mock.module("../../../util/platform.js", () => ({
  getWorkspaceDir: () => TMP_ROOT,
}));

mock.module("../../logger.js", () => ({
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// ── Test fixtures ────────────────────────────────────────────────────

interface FakeRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

const REL_080: FakeRelease = {
  tag_name: "v0.8.0",
  name: "v0.8.0 — Tavily",
  body: "## Tavily web search\n\nNew search provider.",
  published_at: "2026-05-10T12:00:00Z",
  html_url: "https://github.com/vellum-ai/vellum-assistant/releases/tag/v0.8.0",
  draft: false,
  prerelease: false,
};

const REL_079: FakeRelease = {
  tag_name: "v0.7.9",
  name: "v0.7.9",
  body: "## Memory v2\n\nMemory v2 is now the default.",
  published_at: "2026-05-01T12:00:00Z",
  html_url: "https://github.com/vellum-ai/vellum-assistant/releases/tag/v0.7.9",
  draft: false,
  prerelease: false,
};

const REL_080_RC: FakeRelease = {
  tag_name: "v0.8.0-rc.1",
  name: "v0.8.0-rc.1",
  body: "Release candidate.",
  published_at: "2026-05-09T12:00:00Z",
  html_url:
    "https://github.com/vellum-ai/vellum-assistant/releases/tag/v0.8.0-rc.1",
  draft: false,
  prerelease: true,
};

const REL_DRAFT: FakeRelease = {
  tag_name: "v0.8.1",
  name: "v0.8.1 (draft)",
  body: null,
  published_at: null,
  html_url: "https://github.com/vellum-ai/vellum-assistant/releases/tag/v0.8.1",
  draft: true,
  prerelease: false,
};

function stableRelease(tag: string, body = `release ${tag}`): FakeRelease {
  return {
    tag_name: tag,
    name: tag,
    body,
    published_at: "2026-04-01T12:00:00Z",
    html_url: `https://github.com/vellum-ai/vellum-assistant/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
  };
}

// ── fetch mock harness ───────────────────────────────────────────────

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

let fetchHandler: FetchHandler = async () =>
  new Response("not configured", { status: 500 });
const fetchCalls: string[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls.length = 0;
  fetchHandler = async () => new Response("not configured", { status: 500 });
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const url =
      typeof args[0] === "string" ? args[0] : (args[0] as URL).toString();
    fetchCalls.push(url);
    return fetchHandler(url, args[1]);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  // Wipe any cache that earlier tests wrote.
  try {
    rmSync(join(TMP_ROOT, "data"), { recursive: true, force: true });
  } catch {
    // Best effort.
  }
});

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const cachePath = join(TMP_ROOT, "data", "changelog-cache.json");

interface CacheShape {
  fetchedAt: string;
  recent: FakeRelease[];
  byTag: Record<string, FakeRelease>;
}

function readCacheFile(): CacheShape | null {
  if (!existsSync(cachePath)) return null;
  return JSON.parse(readFileSync(cachePath, "utf-8")) as CacheShape;
}

function writeCacheFile(cache: CacheShape): void {
  mkdirSync(join(TMP_ROOT, "data"), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

// ── Import module under test (after mocks) ───────────────────────────

const { registerChangelogCommand } = await import("../changelog.js");

// ── CLI driver ───────────────────────────────────────────────────────

interface CapturedRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(argv: string[]): Promise<CapturedRun> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let captured = 0;
  let exited = false;

  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);
  const realExit = process.exit.bind(process);

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    captured = typeof code === "number" ? code : 0;
    exited = true;
    throw new Error("__test_process_exit__");
  }) as typeof process.exit;

  const program = new Command();
  program.exitOverride();
  registerChangelogCommand(program);

  try {
    await program.parseAsync(["node", "assistant", ...argv]);
  } catch (err) {
    if ((err as Error).message !== "__test_process_exit__") {
      throw err;
    }
  } finally {
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
    process.exit = realExit;
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode: exited ? captured : 0,
  };
}

// ── Default action ───────────────────────────────────────────────────

describe("assistant changelog (default action)", () => {
  test("shows the latest stable release, filtering drafts and prereleases", async () => {
    fetchHandler = async () =>
      jsonResponse([REL_DRAFT, REL_080_RC, REL_080, REL_079]);
    const result = await runCli(["changelog"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# v0.8.0 — Tavily");
    expect(result.stdout).toContain("Published: 2026-05-10");
    expect(result.stdout).toContain(REL_080.html_url);
    expect(result.stdout).toContain("Tavily web search");
    expect(result.stdout).not.toContain("draft");
    expect(result.stdout).not.toContain("rc.1");
  });

  test("--json emits the latest release as a JSON object", async () => {
    fetchHandler = async () => jsonResponse([REL_080, REL_079]);
    const result = await runCli(["changelog", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { tag_name: string };
    expect(parsed.tag_name).toBe("v0.8.0");
  });

  test("--since concatenates every newer stable release, newest first", async () => {
    const REL_081 = stableRelease("v0.8.1", "patch notes");
    fetchHandler = async () => jsonResponse([REL_081, REL_080, REL_079]);
    const result = await runCli(["changelog", "--since", "0.7.9"]);
    expect(result.exitCode).toBe(0);
    const idx081 = result.stdout.indexOf("v0.8.1");
    const idx080 = result.stdout.indexOf("v0.8.0");
    expect(idx081).toBeGreaterThan(-1);
    expect(idx080).toBeGreaterThan(idx081);
    expect(result.stdout).not.toContain("v0.7.9");
  });

  test("--since accepts a tag with or without a v prefix", async () => {
    fetchHandler = async () => jsonResponse([REL_080, REL_079]);
    const result = await runCli(["changelog", "--since", "v0.7.9"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("v0.8.0");
  });

  test("--since with no newer releases exits 0 and emits no release bodies", async () => {
    fetchHandler = async () => jsonResponse([REL_080, REL_079]);
    const result = await runCli(["changelog", "--since", "1.0.0"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Published:");
  });

  test("--since --json emits an empty releases array when nothing matches", async () => {
    fetchHandler = async () => jsonResponse([REL_080]);
    const result = await runCli(["changelog", "--since", "1.0.0", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { releases: unknown[] };
    expect(parsed.releases).toEqual([]);
  });

  test("empty release list (after stable filter) exits non-zero", async () => {
    fetchHandler = async () => jsonResponse([REL_080_RC, REL_DRAFT]);
    const result = await runCli(["changelog"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No releases found");
  });
});

// ── show <version> ───────────────────────────────────────────────────

describe("assistant changelog show <version>", () => {
  test("prints the named release", async () => {
    fetchHandler = async () => jsonResponse(REL_080);
    const result = await runCli(["changelog", "show", "0.8.0"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# v0.8.0 — Tavily");
    expect(fetchCalls[0]).toContain("/releases/tags/v0.8.0");
  });

  test("accepts a v-prefixed input", async () => {
    fetchHandler = async () => jsonResponse(REL_080);
    const result = await runCli(["changelog", "show", "v0.8.0"]);
    expect(result.exitCode).toBe(0);
    expect(fetchCalls[0]).toContain("/releases/tags/v0.8.0");
  });

  test("--json forwards through the parent into the show subcommand", async () => {
    fetchHandler = async () => jsonResponse(REL_080);
    const result = await runCli(["changelog", "show", "0.8.0", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { tag_name: string };
    expect(parsed.tag_name).toBe("v0.8.0");
  });

  test("404 surfaces a friendly stderr and exits non-zero", async () => {
    fetchHandler = async () => new Response("not found", { status: 404 });
    const result = await runCli(["changelog", "show", "99.99.99"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No release found");
  });

  test("persists a fetched tag into the cache so the next call short-circuits", async () => {
    let callCount = 0;
    fetchHandler = async () => {
      callCount += 1;
      return jsonResponse(REL_079);
    };

    const first = await runCli(["changelog", "show", "0.7.9"]);
    expect(first.exitCode).toBe(0);
    expect(callCount).toBe(1);

    const cached = readCacheFile();
    expect(cached?.byTag["v0.7.9"]?.tag_name).toBe("v0.7.9");

    const second = await runCli(["changelog", "show", "0.7.9"]);
    expect(second.exitCode).toBe(0);
    expect(callCount).toBe(1); // no extra fetch
  });

  test("--no-cache skips the cached entry and refetches", async () => {
    writeCacheFile({
      fetchedAt: new Date().toISOString(),
      recent: [],
      byTag: { "v0.8.0": REL_080 },
    });
    fetchHandler = async () => jsonResponse(REL_080);
    const result = await runCli(["changelog", "show", "0.8.0", "--no-cache"]);
    expect(result.exitCode).toBe(0);
    expect(fetchCalls).toHaveLength(1);
  });
});

// ── list ──────────────────────────────────────────────────────────────

describe("assistant changelog list", () => {
  test("prints one row per stable release", async () => {
    fetchHandler = async () =>
      jsonResponse([REL_080_RC, REL_080, REL_DRAFT, REL_079]);
    const result = await runCli(["changelog", "list"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("v0.8.0");
    expect(lines[0]).toContain("2026-05-10");
    expect(lines[1]).toContain("v0.7.9");
  });

  test("--json emits a releases array", async () => {
    fetchHandler = async () => jsonResponse([REL_080, REL_079]);
    const result = await runCli(["changelog", "list", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      releases: Array<{ tag_name: string }>;
    };
    expect(parsed.releases.map((r) => r.tag_name)).toEqual([
      "v0.8.0",
      "v0.7.9",
    ]);
  });

  test("--no-cache --json --limit forwards parent flags into the subcommand", async () => {
    fetchHandler = async () =>
      jsonResponse([REL_080, REL_079, stableRelease("v0.7.8")]);
    const result = await runCli([
      "changelog",
      "list",
      "--no-cache",
      "--json",
      "--limit",
      "5",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      releases: Array<{ tag_name: string }>;
    };
    expect(parsed.releases.length).toBeGreaterThan(0);
    // Even with --limit 5, the page-size buffer absorbs drafts/prereleases.
    expect(fetchCalls[0]).toMatch(/per_page=\d+/);
  });
});

// ── Cache behavior ───────────────────────────────────────────────────

describe("assistant changelog cache", () => {
  test("second invocation reuses a fresh cache without re-fetching", async () => {
    let callCount = 0;
    fetchHandler = async () => {
      callCount += 1;
      return jsonResponse([REL_080, REL_079]);
    };
    await runCli(["changelog"]);
    expect(callCount).toBe(1);

    await runCli(["changelog"]);
    // Second call should hit the rolling-recent cache: latest is still
    // populated and not stale, and we only need 1 entry for the default
    // action.
    expect(callCount).toBe(1);
  });

  test("--no-cache forces a refetch even with a fresh cache", async () => {
    writeCacheFile({
      fetchedAt: new Date().toISOString(),
      recent: [REL_080, REL_079],
      byTag: { "v0.8.0": REL_080, "v0.7.9": REL_079 },
    });
    let callCount = 0;
    fetchHandler = async () => {
      callCount += 1;
      return jsonResponse([REL_080, REL_079]);
    };
    const result = await runCli(["changelog", "--no-cache"]);
    expect(result.exitCode).toBe(0);
    expect(callCount).toBe(1);
  });

  test("stale cache (older than TTL) triggers a refetch", async () => {
    writeCacheFile({
      fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      recent: [REL_079],
      byTag: { "v0.7.9": REL_079 },
    });
    let callCount = 0;
    fetchHandler = async () => {
      callCount += 1;
      return jsonResponse([REL_080, REL_079]);
    };
    await runCli(["changelog"]);
    expect(callCount).toBe(1);
  });

  test("corrupt cache JSON is treated as a miss", async () => {
    mkdirSync(join(TMP_ROOT, "data"), { recursive: true });
    writeFileSync(cachePath, "{not valid json");
    let callCount = 0;
    fetchHandler = async () => {
      callCount += 1;
      return jsonResponse([REL_080]);
    };
    await runCli(["changelog"]);
    expect(callCount).toBe(1);
  });

  test("rolling cache is capped at 5 stable releases regardless of fetched count", async () => {
    const stables = [
      stableRelease("v0.9.0"),
      stableRelease("v0.8.9"),
      stableRelease("v0.8.8"),
      stableRelease("v0.8.7"),
      stableRelease("v0.8.6"),
      stableRelease("v0.8.5"),
      stableRelease("v0.8.4"),
      stableRelease("v0.8.3"),
    ];
    fetchHandler = async () => jsonResponse(stables);
    await runCli(["changelog", "list", "--limit", "8"]);

    const cached = readCacheFile();
    expect(cached?.recent.length).toBe(5);
    expect(cached?.recent.map((r) => r.tag_name)).toEqual([
      "v0.9.0",
      "v0.8.9",
      "v0.8.8",
      "v0.8.7",
      "v0.8.6",
    ]);
  });

  test("page-size buffer absorbs drafts/prereleases so a small --limit still surfaces stable releases", async () => {
    // First page is mostly noise — drafts and prereleases — followed by
    // stable releases. With a hardcoded per_page=limit the small budget
    // would be eaten by noise. The buffer keeps stable releases visible.
    const noise = Array.from({ length: 10 }, (_, i) => ({
      ...REL_DRAFT,
      tag_name: `v9.9.${i}`,
    }));
    fetchHandler = async () => jsonResponse([...noise, REL_080, REL_079]);
    const result = await runCli([
      "changelog",
      "list",
      "--limit",
      "2",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      releases: Array<{ tag_name: string }>;
    };
    expect(parsed.releases.map((r) => r.tag_name)).toEqual([
      "v0.8.0",
      "v0.7.9",
    ]);
  });

  test("--limit larger than cached count refetches to satisfy the request", async () => {
    writeCacheFile({
      fetchedAt: new Date().toISOString(),
      recent: [REL_080],
      byTag: { "v0.8.0": REL_080 },
    });
    let callCount = 0;
    fetchHandler = async () => {
      callCount += 1;
      return jsonResponse([REL_080, REL_079]);
    };
    await runCli(["changelog", "list", "--limit", "10"]);
    expect(callCount).toBe(1);
  });
});

// ── Errors ───────────────────────────────────────────────────────────

describe("assistant changelog errors", () => {
  test("403 rate-limit response surfaces a friendly stderr", async () => {
    fetchHandler = async () =>
      new Response("rate limit exceeded", { status: 403 });
    const result = await runCli(["changelog", "--no-cache"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/rate limit/i);
  });

  test("429 rate-limit response also surfaces the friendly message", async () => {
    fetchHandler = async () =>
      new Response("too many requests", { status: 429 });
    const result = await runCli(["changelog", "--no-cache"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/rate limit/i);
  });

  test("500 from GitHub surfaces the status code", async () => {
    fetchHandler = async () => new Response("server is sad", { status: 500 });
    const result = await runCli(["changelog", "--no-cache"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("500");
  });
});
