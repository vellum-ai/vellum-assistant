/**
 * Tests for {@link searchPlugins}.
 *
 * Network is replaced with an in-memory fixture passed via the `fetch`
 * dependency — no globals are monkey-patched and no `--test-hook` exports
 * leak into production code.
 */

import { describe, expect, test } from "bun:test";

import {
  type FetchLike,
  InvalidSearchPatternError,
  searchPlugins,
} from "../search-plugins.js";

/**
 * Build a GitHub Contents API fixture from an in-memory directory listing.
 *
 * `entries` maps each name under `experimental/plugins/` to its `type`. The
 * fixture answers GET requests against
 *  - `https://api.github.com/repos/vellum-ai/vellum-assistant/contents/experimental/plugins...`
 * and returns 500 for anything else (forces test bugs to surface loudly).
 */
function fixtureFetch(
  entries: Record<string, "dir" | "file" | "symlink" | "submodule">,
): FetchLike {
  const PREFIX_API =
    "https://api.github.com/repos/vellum-ai/vellum-assistant/contents/experimental/plugins";

  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.startsWith(PREFIX_API)) {
      return new Response("unexpected url: " + url, { status: 500 });
    }
    const body = Object.entries(entries).map(([name, type]) => ({
      name,
      path: `experimental/plugins/${name}`,
      type,
      size: type === "file" ? 1 : 0,
      download_url:
        type === "file"
          ? `https://raw.githubusercontent.com/vellum-ai/vellum-assistant/main/experimental/plugins/${name}`
          : null,
    }));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
}

describe("searchPlugins", () => {
  test("matches the query as a case-insensitive regex against directory names", async () => {
    const result = await searchPlugins(
      { query: "memory" },
      {
        fetch: fixtureFetch({
          "simple-memory": "dir",
          "memory-graph": "dir",
          "git-tools": "dir",
        }),
      },
    );

    expect(result.matches.map((m) => m.name)).toEqual([
      "memory-graph",
      "simple-memory",
    ]);
    expect(result.matches[0]!.path).toBe("experimental/plugins/memory-graph");
    expect(result.query).toBe("memory");
    expect(result.ref).toBe("main");
  });

  test("matches regardless of query casing (case-insensitive)", async () => {
    const result = await searchPlugins(
      { query: "MEMORY" },
      { fetch: fixtureFetch({ "simple-memory": "dir" }) },
    );
    expect(result.matches.map((m) => m.name)).toEqual(["simple-memory"]);
  });

  test("anchored patterns work without escaping", async () => {
    const result = await searchPlugins(
      { query: "^memory-" },
      {
        fetch: fixtureFetch({
          "memory-graph": "dir",
          "simple-memory": "dir",
        }),
      },
    );
    expect(result.matches.map((m) => m.name)).toEqual(["memory-graph"]);
  });

  test("empty query matches all directories", async () => {
    const result = await searchPlugins(
      { query: "" },
      {
        fetch: fixtureFetch({
          "simple-memory": "dir",
          "memory-graph": "dir",
          "git-tools": "dir",
        }),
      },
    );
    expect(result.matches.map((m) => m.name)).toEqual([
      "git-tools",
      "memory-graph",
      "simple-memory",
    ]);
  });

  test("skips entries that are not directories", async () => {
    const result = await searchPlugins(
      { query: "" },
      {
        fetch: fixtureFetch({
          "simple-memory": "dir",
          "README.md": "file",
          "broken-symlink": "symlink",
          "old-plugin": "submodule",
        }),
      },
    );
    expect(result.matches.map((m) => m.name)).toEqual(["simple-memory"]);
  });

  test("rejects invalid regex patterns up front (no network call)", async () => {
    let fetchCalled = false;
    const fetch: FetchLike = (async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as FetchLike;

    await expect(
      searchPlugins({ query: "(unterminated" }, { fetch }),
    ).rejects.toBeInstanceOf(InvalidSearchPatternError);
    expect(fetchCalled).toBe(false);
  });

  test("empty result set on no matches", async () => {
    const result = await searchPlugins(
      { query: "nothing-matches" },
      { fetch: fixtureFetch({ "simple-memory": "dir" }) },
    );
    expect(result.matches).toEqual([]);
  });

  test("respects `ref` option by forwarding to GitHub", async () => {
    // The CLI does not surface a `--ref` flag (the source-path convention
    // may change), but the underlying function keeps `ref` for test
    // injection and future internal callers.
    let seenRef: string | undefined;
    const result = await searchPlugins(
      { query: "memory", ref: "feat-branch" },
      {
        fetch: (async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          const m = /[?&]ref=([^&]+)/.exec(url);
          seenRef = m ? decodeURIComponent(m[1]!) : undefined;
          return new Response(
            JSON.stringify([
              {
                name: "simple-memory",
                path: "experimental/plugins/simple-memory",
                type: "dir",
                size: 0,
                download_url: null,
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as FetchLike,
      },
    );

    expect(seenRef).toBe("feat-branch");
    expect(result.ref).toBe("feat-branch");
    expect(result.matches.map((m) => m.name)).toEqual(["simple-memory"]);
  });

  test("HTTP 5xx from GitHub propagates with the status code", async () => {
    await expect(
      searchPlugins(
        { query: "memory" },
        {
          fetch: (async () =>
            new Response("upstream broken", { status: 503 })) as FetchLike,
        },
      ),
    ).rejects.toThrow(/HTTP 503/);
  });

  test("HTTP 403 (rate-limited / forbidden) surfaces as an error", async () => {
    await expect(
      searchPlugins(
        { query: "memory" },
        {
          fetch: (async () =>
            new Response("rate limit exceeded", { status: 403 })) as FetchLike,
        },
      ),
    ).rejects.toThrow(/HTTP 403/);
  });

  test("404 on the plugins prefix surfaces as an error (not silently empty)", async () => {
    // Distinct from `installPlugin`, where 404 on a specific plugin name is
    // normal "not found". For the search, 404 on the prefix means the
    // canonical source path itself is gone — that's an upstream problem
    // worth surfacing, not a clean empty result.
    await expect(
      searchPlugins(
        { query: "memory" },
        {
          fetch: (async () =>
            new Response("not found", { status: 404 })) as FetchLike,
        },
      ),
    ).rejects.toThrow(/HTTP 404/);
  });

  test("returns matches sorted by name", async () => {
    const result = await searchPlugins(
      { query: "" },
      {
        fetch: fixtureFetch({
          "zeta-plugin": "dir",
          "alpha-plugin": "dir",
          "mu-plugin": "dir",
        }),
      },
    );
    expect(result.matches.map((m) => m.name)).toEqual([
      "alpha-plugin",
      "mu-plugin",
      "zeta-plugin",
    ]);
  });

  test("merges whitelisted marketplace entries with first-party dirs", async () => {
    // GIVEN the canonical repo serves both a first-party plugin listing and a
    // marketplace manifest whitelisting an external plugin
    const manifest = {
      name: "vellum-assistant",
      plugins: [
        {
          name: "caveman",
          source: {
            source: "github",
            repo: "JuliusBrussee/caveman",
            ref: "v1.8.2",
          },
          description: "Ultra-compressed communication mode.",
        },
      ],
    };
    const fetch: FetchLike = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("marketplace.json")) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      return new Response(
        JSON.stringify([
          {
            name: "simple-memory",
            path: "experimental/plugins/simple-memory",
            type: "dir",
            size: 0,
            download_url: null,
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as FetchLike;

    // WHEN we search the catalog with a match-all query
    const result = await searchPlugins({ query: "" }, { fetch });

    // THEN both sources appear, sorted by name, each tagged with its origin
    expect(result.matches).toEqual([
      {
        name: "caveman",
        path: "github:JuliusBrussee/caveman@v1.8.2",
        description: "Ultra-compressed communication mode.",
        source: {
          kind: "github",
          repo: "JuliusBrussee/caveman",
          ref: "v1.8.2",
        },
      },
      {
        name: "simple-memory",
        path: "experimental/plugins/simple-memory",
        source: { kind: "first-party" },
      },
    ]);
  });

  test("filters marketplace entries by the query too", async () => {
    // GIVEN a marketplace whitelisting an external plugin and no first-party dirs
    const manifest = {
      name: "vellum-assistant",
      plugins: [
        {
          name: "caveman",
          source: {
            source: "github",
            repo: "JuliusBrussee/caveman",
            ref: "v1.8.2",
          },
        },
      ],
    };
    const fetch: FetchLike = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("marketplace.json")) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as FetchLike;

    // WHEN the query matches no plugin name
    const result = await searchPlugins({ query: "memory" }, { fetch });

    // THEN the non-matching marketplace entry is excluded
    expect(result.matches).toEqual([]);
  });

  test("first-party dirs win a name collision with the marketplace", async () => {
    // GIVEN both a first-party dir and a marketplace entry named "caveman"
    const manifest = {
      name: "vellum-assistant",
      plugins: [
        {
          name: "caveman",
          source: {
            source: "github",
            repo: "JuliusBrussee/caveman",
            ref: "v1.8.2",
          },
        },
      ],
    };
    const fetch: FetchLike = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("marketplace.json")) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      return new Response(
        JSON.stringify([
          {
            name: "caveman",
            path: "experimental/plugins/caveman",
            type: "dir",
            size: 0,
            download_url: null,
          },
        ]),
        { status: 200 },
      );
    }) as FetchLike;

    // WHEN we search
    const result = await searchPlugins({ query: "caveman" }, { fetch });

    // THEN only the first-party entry surfaces — the manifest is additive
    expect(result.matches).toEqual([
      {
        name: "caveman",
        path: "experimental/plugins/caveman",
        source: { kind: "first-party" },
      },
    ]);
  });

  test("a broken marketplace manifest degrades to the first-party listing", async () => {
    // GIVEN the manifest is malformed but the first-party listing is healthy
    const fetch: FetchLike = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("marketplace.json")) {
        return new Response("{ not json", { status: 200 });
      }
      return new Response(
        JSON.stringify([
          {
            name: "simple-memory",
            path: "experimental/plugins/simple-memory",
            type: "dir",
            size: 0,
            download_url: null,
          },
        ]),
        { status: 200 },
      );
    }) as FetchLike;

    // WHEN we search
    const result = await searchPlugins({ query: "" }, { fetch });

    // THEN the core catalog is unaffected by the broken whitelist
    expect(result.matches.map((m) => m.name)).toEqual(["simple-memory"]);
  });

  test("sends no Authorization header (canonical source is a public repo)", async () => {
    let seenAuth: string | undefined;
    let seenUserAgent: string | undefined;
    await searchPlugins(
      { query: "memory" },
      {
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          const headers = init?.headers as Record<string, string> | undefined;
          seenAuth = headers?.Authorization;
          seenUserAgent = headers?.["User-Agent"];
          return new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as FetchLike,
      },
    );
    expect(seenAuth).toBeUndefined();
    expect(seenUserAgent).toBe("vellum-assistant-cli");
  });
});
