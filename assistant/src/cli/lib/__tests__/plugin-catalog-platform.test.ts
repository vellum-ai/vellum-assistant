/**
 * Tests for {@link fetchPluginCatalogFromPlatform}.
 *
 * The platform `/v1/plugins/` endpoint is replaced with an in-memory fixture
 * passed via the injected `fetch` dependency — no globals are patched. Each
 * case asserts that a well-formed response maps to a sorted match list and that
 * every failure mode throws {@link PluginCatalogUnavailableError} rather than
 * returning a partial or empty catalog.
 */

import { describe, expect, test } from "bun:test";

import type { FetchLike } from "../fetch-like.js";
import { fetchPluginCatalogFromPlatform } from "../plugin-catalog-platform.js";
import { PluginCatalogUnavailableError } from "../search-plugins.js";

const SHA_A = "63a91ecadbf4c4719a4602a5abb00883f9966034";
const SHA_B = "0123456789abcdef0123456789abcdef01234567";

/** Serve `body` (object or raw string) at the `/v1/plugins/` endpoint. */
function platformFetch(body: unknown, status = 200): FetchLike {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as FetchLike;
}

describe("fetchPluginCatalogFromPlatform", () => {
  test("maps well-formed rows to sorted matches", async () => {
    const catalog = await fetchPluginCatalogFromPlatform({
      fetch: platformFetch({
        plugins: [
          {
            name: "memory-graph",
            repo: "acme/memory-graph",
            ref: SHA_B,
            path: "packages/plugin",
            description: "graph memory",
            category: "productivity",
            homepage: "https://example.com",
            license: "MIT",
            // dropped keys
            id: "abc",
            display_name: "Memory Graph",
            icon: "🧠",
          },
          {
            name: "alpha-tool",
            repo: "vellum-ai/alpha-tool",
            ref: SHA_A,
          },
        ],
      }),
    });

    expect(catalog.ref).toBe("platform");
    expect(catalog.matches.map((m) => m.name)).toEqual([
      "alpha-tool",
      "memory-graph",
    ]);

    const graph = catalog.matches[1];
    expect(graph).toMatchObject({
      name: "memory-graph",
      path: `github:acme/memory-graph/packages/plugin@${SHA_B}`,
      description: "graph memory",
      category: "productivity",
      homepage: "https://example.com",
      license: "MIT",
      source: {
        kind: "github",
        repo: "acme/memory-graph",
        path: "packages/plugin",
        ref: SHA_B,
      },
    });

    const alpha = catalog.matches[0];
    expect(alpha.category).toBeNull();
    expect(alpha.homepage).toBeUndefined();
    expect(alpha.license).toBeUndefined();
    expect(alpha.source).toEqual({
      kind: "github",
      repo: "vellum-ai/alpha-tool",
      path: undefined,
      ref: SHA_A,
    });
  });

  test("honors an explicit ref label", async () => {
    const catalog = await fetchPluginCatalogFromPlatform(
      { fetch: platformFetch({ plugins: [] }) },
      { ref: "v1.2.3" },
    );
    expect(catalog.ref).toBe("v1.2.3");
    expect(catalog.matches).toEqual([]);
  });

  test("skips rows missing repo or ref", async () => {
    const catalog = await fetchPluginCatalogFromPlatform({
      fetch: platformFetch({
        plugins: [
          { name: "no-repo", ref: SHA_A },
          { name: "no-ref", repo: "acme/no-ref" },
          { name: "null-repo", repo: null, ref: SHA_A },
          { name: "good", repo: "acme/good", ref: SHA_B },
        ],
      }),
    });
    expect(catalog.matches.map((m) => m.name)).toEqual(["good"]);
  });

  test("dedupes by name, keeping the first occurrence", async () => {
    const catalog = await fetchPluginCatalogFromPlatform({
      fetch: platformFetch({
        plugins: [
          { name: "dup", repo: "acme/first", ref: SHA_A },
          { name: "dup", repo: "acme/second", ref: SHA_B },
        ],
      }),
    });
    expect(catalog.matches).toHaveLength(1);
    expect(catalog.matches[0].source.repo).toBe("acme/first");
  });

  test.each([503, 500, 404])(
    "throws on a non-2xx response (%i)",
    async (status) => {
      const promise = fetchPluginCatalogFromPlatform({
        fetch: platformFetch("upstream broken", status),
      });
      await expect(promise).rejects.toBeInstanceOf(
        PluginCatalogUnavailableError,
      );
      await expect(promise).rejects.toMatchObject({ status });
    },
  );

  test("throws on a malformed JSON body", async () => {
    const promise = fetchPluginCatalogFromPlatform({
      fetch: platformFetch("{ not json", 200),
    });
    await expect(promise).rejects.toBeInstanceOf(PluginCatalogUnavailableError);
    await expect(promise).rejects.toMatchObject({ status: 502 });
  });

  test("throws on a schema violation", async () => {
    const promise = fetchPluginCatalogFromPlatform({
      fetch: platformFetch({ plugins: [{ repo: "acme/x", ref: SHA_A }] }),
    });
    await expect(promise).rejects.toBeInstanceOf(PluginCatalogUnavailableError);
    await expect(promise).rejects.toMatchObject({ status: 502 });
  });

  test("throws when fetch rejects (network error / abort)", async () => {
    const promise = fetchPluginCatalogFromPlatform({
      fetch: (async () => {
        throw new Error("network down");
      }) as FetchLike,
    });
    await expect(promise).rejects.toBeInstanceOf(PluginCatalogUnavailableError);
    await expect(promise).rejects.toMatchObject({ status: 503 });
  });
});
