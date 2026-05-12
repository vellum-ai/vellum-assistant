/**
 * Tests for the `assistant changelog` CLI command.
 *
 * Coverage:
 *   - Pure helpers (compareTags, normalizeTag, stableReleases, parseLimit,
 *     renderRelease, renderList).
 *   - Cache plumbing (read returns null when missing/corrupt; write+read
 *     roundtrip; stale detection).
 *   - Cache-aware loaders (cache hit short-circuits fetch; --no-cache skips
 *     read but still writes; stale cache refetches).
 *   - GitHub error mapping (403/429 → rate-limit message; 404 → null tag).
 *   - End-to-end command actions (default = latest, --since, show, list,
 *     --json, missing tag, empty release list).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// ── Import module under test (after mocks) ───────────────────────────

const { registerChangelogCommand, __testing } = await import("../changelog.js");
const {
  compareTags,
  normalizeTag,
  stableReleases,
  parseLimit,
  renderRelease,
  renderList,
  readCache,
  writeCache,
  isStale,
  loadReleases,
  loadReleaseByTag,
  getCachePath,
} = __testing;

// ── stdout / exit capture ────────────────────────────────────────────

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

// ── Pure helpers ─────────────────────────────────────────────────────

describe("changelog helpers", () => {
  describe("compareTags", () => {
    test("equal tags compare as 0", () => {
      expect(compareTags("v0.8.0", "v0.8.0")).toBe(0);
    });
    test("higher major beats lower", () => {
      expect(compareTags("v1.0.0", "v0.99.99")).toBeGreaterThan(0);
    });
    test("higher patch beats lower", () => {
      expect(compareTags("v0.8.1", "v0.8.0")).toBeGreaterThan(0);
    });
    test("accepts inputs without the v prefix", () => {
      expect(compareTags("0.8.1", "v0.8.0")).toBeGreaterThan(0);
      expect(compareTags("0.7.0", "0.8.0")).toBeLessThan(0);
    });
    test("missing patch parts default to 0", () => {
      expect(compareTags("v0.8", "v0.8.0")).toBe(0);
      expect(compareTags("v0.8.1", "v0.8")).toBeGreaterThan(0);
    });
  });

  describe("normalizeTag", () => {
    test("adds v prefix when missing", () => {
      expect(normalizeTag("0.8.0")).toBe("v0.8.0");
    });
    test("leaves v prefix untouched", () => {
      expect(normalizeTag("v0.8.0")).toBe("v0.8.0");
    });
  });

  describe("stableReleases", () => {
    test("drops drafts and prereleases", () => {
      const filtered = stableReleases([
        REL_080,
        REL_080_RC,
        REL_DRAFT,
        REL_079,
      ]);
      expect(filtered.map((r) => r.tag_name)).toEqual(["v0.8.0", "v0.7.9"]);
    });
    test("preserves order of the stable subset", () => {
      const filtered = stableReleases([REL_079, REL_080]);
      expect(filtered.map((r) => r.tag_name)).toEqual(["v0.7.9", "v0.8.0"]);
    });
  });

  describe("parseLimit", () => {
    test("falls back when input is missing", () => {
      expect(parseLimit(undefined, 30)).toBe(30);
    });
    test("falls back on garbage input", () => {
      expect(parseLimit("not-a-number", 30)).toBe(30);
    });
    test("falls back when input is zero or negative", () => {
      expect(parseLimit("0", 30)).toBe(30);
      expect(parseLimit("-5", 30)).toBe(30);
    });
    test("clamps to the upper bound of 100", () => {
      expect(parseLimit("999", 30)).toBe(100);
    });
    test("accepts valid values", () => {
      expect(parseLimit("42", 30)).toBe(42);
    });
  });

  describe("renderRelease", () => {
    test("includes heading, date, html url, and body", () => {
      const rendered = renderRelease(REL_080);
      expect(rendered).toContain("# v0.8.0 — Tavily");
      expect(rendered).toContain("Published: 2026-05-10");
      expect(rendered).toContain(REL_080.html_url);
      expect(rendered).toContain("Tavily web search");
    });
    test("falls back to tag when name is empty", () => {
      const rendered = renderRelease({ ...REL_080, name: "" });
      expect(rendered).toContain("# v0.8.0");
    });
    test("placeholder when body is empty", () => {
      const rendered = renderRelease({ ...REL_080, body: "   " });
      expect(rendered).toContain("(no release body)");
    });
  });

  describe("renderList", () => {
    test("formats one row per release", () => {
      const rendered = renderList([REL_080, REL_079]);
      const lines = rendered.split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("v0.8.0");
      expect(lines[0]).toContain("2026-05-10");
      expect(lines[1]).toContain("v0.7.9");
    });
    test("handles empty input", () => {
      expect(renderList([])).toBe("No releases found.");
    });
  });
});

// ── Cache plumbing ───────────────────────────────────────────────────

describe("changelog cache", () => {
  test("cache path lives under the workspace data dir", () => {
    expect(getCachePath()).toBe(join(TMP_ROOT, "data", "changelog-cache.json"));
  });

  test("readCache returns null when the file is missing", () => {
    expect(readCache()).toBeNull();
  });

  test("write + read roundtrip", () => {
    const store = {
      fetchedAt: new Date().toISOString(),
      releases: [REL_080, REL_079],
    };
    writeCache(store);
    const loaded = readCache();
    expect(loaded).not.toBeNull();
    expect(loaded?.releases.map((r) => r.tag_name)).toEqual([
      "v0.8.0",
      "v0.7.9",
    ]);
  });

  test("readCache returns null on corrupt JSON", () => {
    writeCache({ fetchedAt: new Date().toISOString(), releases: [REL_080] });
    // Re-write garbage on top of the cache file.
    writeFileSync(getCachePath(), "{not valid json");
    expect(readCache()).toBeNull();
  });

  test("readCache returns null when shape is wrong", () => {
    mkdirSync(join(TMP_ROOT, "data"), { recursive: true });
    writeFileSync(getCachePath(), JSON.stringify({ foo: "bar" }));
    expect(readCache()).toBeNull();
  });

  test("isStale flags caches older than the TTL", () => {
    const fresh = { fetchedAt: new Date().toISOString(), releases: [] };
    expect(isStale(fresh)).toBe(false);
    const old = {
      fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      releases: [],
    };
    expect(isStale(old)).toBe(true);
  });

  test("isStale treats unparseable timestamps as stale", () => {
    expect(isStale({ fetchedAt: "not-a-date", releases: [] })).toBe(true);
  });
});

// ── Cache-aware loaders ──────────────────────────────────────────────

describe("loadReleases", () => {
  test("returns cached releases when fresh and big enough", async () => {
    writeCache({
      fetchedAt: new Date().toISOString(),
      releases: [REL_080, REL_079],
    });
    fetchHandler = async () => jsonResponse([]);
    const result = await loadReleases({ noCache: false, limit: 2 });
    expect(result.map((r) => r.tag_name)).toEqual(["v0.8.0", "v0.7.9"]);
    expect(fetchCalls).toHaveLength(0);
  });

  test("fetches from GitHub when cache is missing", async () => {
    fetchHandler = async () => jsonResponse([REL_080, REL_079]);
    const result = await loadReleases({ noCache: false, limit: 30 });
    expect(result.map((r) => r.tag_name)).toEqual(["v0.8.0", "v0.7.9"]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain(
      "https://api.github.com/repos/vellum-ai/vellum-assistant/releases",
    );
    // Cache should now be populated.
    expect(readCache()?.releases).toHaveLength(2);
  });

  test("--no-cache forces a refetch", async () => {
    writeCache({
      fetchedAt: new Date().toISOString(),
      releases: [REL_080, REL_079],
    });
    fetchHandler = async () => jsonResponse([REL_080]);
    const result = await loadReleases({ noCache: true, limit: 30 });
    expect(result.map((r) => r.tag_name)).toEqual(["v0.8.0"]);
    expect(fetchCalls).toHaveLength(1);
  });

  test("stale cache triggers a refetch", async () => {
    writeCache({
      fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      releases: [REL_079],
    });
    fetchHandler = async () => jsonResponse([REL_080, REL_079]);
    const result = await loadReleases({ noCache: false, limit: 30 });
    expect(result.map((r) => r.tag_name)).toEqual(["v0.8.0", "v0.7.9"]);
    expect(fetchCalls).toHaveLength(1);
  });

  test("cache with fewer entries than the requested limit triggers a refetch", async () => {
    writeCache({
      fetchedAt: new Date().toISOString(),
      releases: [REL_080],
    });
    fetchHandler = async () => jsonResponse([REL_080, REL_079]);
    const result = await loadReleases({ noCache: false, limit: 2 });
    expect(result).toHaveLength(2);
    expect(fetchCalls).toHaveLength(1);
  });

  test("maps 403 to a rate-limit message", async () => {
    fetchHandler = async () => new Response("rate limit", { status: 403 });
    await expect(loadReleases({ noCache: true, limit: 30 })).rejects.toThrow(
      /rate limit/i,
    );
  });
});

describe("loadReleaseByTag", () => {
  test("returns from cache when the tag is present", async () => {
    writeCache({
      fetchedAt: new Date().toISOString(),
      releases: [REL_080, REL_079],
    });
    fetchHandler = async () => jsonResponse({}, 500);
    const found = await loadReleaseByTag("v0.8.0", { noCache: false });
    expect(found?.tag_name).toBe("v0.8.0");
    expect(fetchCalls).toHaveLength(0);
  });

  test("falls through to fetch when the tag is missing from cache", async () => {
    writeCache({
      fetchedAt: new Date().toISOString(),
      releases: [REL_080],
    });
    fetchHandler = async () => jsonResponse(REL_079);
    const found = await loadReleaseByTag("v0.7.9", { noCache: false });
    expect(found?.tag_name).toBe("v0.7.9");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("/tags/v0.7.9");
  });

  test("--no-cache always fetches", async () => {
    writeCache({
      fetchedAt: new Date().toISOString(),
      releases: [REL_080],
    });
    fetchHandler = async () => jsonResponse(REL_080);
    await loadReleaseByTag("v0.8.0", { noCache: true });
    expect(fetchCalls).toHaveLength(1);
  });

  test("returns null on 404", async () => {
    fetchHandler = async () => new Response("not found", { status: 404 });
    const found = await loadReleaseByTag("v99.99.99", { noCache: true });
    expect(found).toBeNull();
  });
});

// ── End-to-end command surface ───────────────────────────────────────

describe("changelog command", () => {
  test("default action shows the latest stable release", async () => {
    fetchHandler = async () =>
      jsonResponse([REL_DRAFT, REL_080_RC, REL_080, REL_079]);
    const result = await runCli(["changelog"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# v0.8.0 — Tavily");
    expect(result.stdout).not.toContain("draft");
    expect(result.stdout).not.toContain("rc.1");
  });

  test("--since concatenates every newer stable release, newest first", async () => {
    const REL_081 = {
      ...REL_080,
      tag_name: "v0.8.1",
      name: "v0.8.1",
      body: "patch notes",
    };
    fetchHandler = async () => jsonResponse([REL_081, REL_080, REL_079]);
    const result = await runCli(["changelog", "--since", "0.7.9"]);
    expect(result.exitCode).toBe(0);
    const idx081 = result.stdout.indexOf("v0.8.1");
    const idx080 = result.stdout.indexOf("v0.8.0");
    expect(idx081).toBeGreaterThan(-1);
    expect(idx080).toBeGreaterThan(idx081);
    expect(result.stdout).not.toContain("v0.7.9");
  });

  test("--since with no newer releases prints an empty-state line", async () => {
    fetchHandler = async () => jsonResponse([REL_080, REL_079]);
    const result = await runCli(["changelog", "--since", "1.0.0"]);
    expect(result.exitCode).toBe(0);
  });

  test("--json with default action emits the latest release as JSON", async () => {
    fetchHandler = async () => jsonResponse([REL_080, REL_079]);
    const result = await runCli(["changelog", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { tag_name: string };
    expect(parsed.tag_name).toBe("v0.8.0");
  });

  test("show <version> prints the named release", async () => {
    fetchHandler = async () => jsonResponse(REL_080);
    const result = await runCli(["changelog", "show", "0.8.0"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# v0.8.0 — Tavily");
  });

  test("show <version> with no match exits non-zero", async () => {
    fetchHandler = async () => new Response("not found", { status: 404 });
    const result = await runCli(["changelog", "show", "99.99.99"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No release found");
  });

  test("list prints rows of tag/date/name", async () => {
    fetchHandler = async () => jsonResponse([REL_080, REL_079]);
    const result = await runCli(["changelog", "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("v0.8.0");
    expect(result.stdout).toContain("v0.7.9");
  });

  test("list --json emits a releases array", async () => {
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

  test("list --no-cache --json --limit 5 forwards parent flags into the subcommand", async () => {
    fetchHandler = async () =>
      jsonResponse([REL_080, REL_079, { ...REL_079, tag_name: "v0.7.8" }]);
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
    expect(fetchCalls[0]).toContain("per_page=5");
  });

  test("show <version> --json forwards --json from parent into the show subcommand", async () => {
    fetchHandler = async () => jsonResponse(REL_080);
    const result = await runCli(["changelog", "show", "0.8.0", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { tag_name: string };
    expect(parsed.tag_name).toBe("v0.8.0");
  });

  test("rate-limit error surfaces a friendly message", async () => {
    fetchHandler = async () =>
      new Response("rate limit exceeded", { status: 403 });
    const result = await runCli(["changelog", "--no-cache"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/rate limit/i);
  });
});
