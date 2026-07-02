/**
 * Tests for {@link getPluginDetails}.
 *
 * Network is replaced with an in-memory GitHub Contents API fixture passed via
 * the `fetch` dependency, and the installed-copy path is exercised against a
 * real temp directory passed via `workspacePluginsDir` — no globals are
 * monkey-patched. The fixture answers three URL shapes:
 *   - the marketplace manifest file (raw JSON body),
 *   - directory listings (`/contents/<path>` → entry array or 404),
 *   - raw file downloads (a listing entry's `download_url`).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { FetchLike } from "../install-from-github.js";
import {
  getPluginDetails,
  PluginDetailsNotFoundError,
} from "../plugin-details.js";

interface ContentEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  download_url: string | null;
}

function fileEntry(name: string, downloadUrl: string): ContentEntry {
  return { name, path: name, type: "file", download_url: downloadUrl };
}

interface FixtureConfig {
  /** Manifest object served at `plugins/marketplace.json`. Omit for 404. */
  marketplace?: unknown;
  /** Directory listings keyed by `<owner>/<repo>[/<path>]`. Missing key → 404. */
  listings?: Record<string, ContentEntry[]>;
  /** Raw file bodies keyed by `download_url`. Missing key → 404. */
  raw?: Record<string, string>;
  /** URL substrings that should reject with a network error. */
  failOn?: string[];
}

/**
 * Build a `fetch` that routes GitHub Contents API requests against in-memory
 * fixtures. Anything unrecognised returns 500 so test bugs surface loudly.
 */
function makeFetch(config: FixtureConfig): FetchLike {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    for (const needle of config.failOn ?? []) {
      if (url.includes(needle)) throw new Error(`network down: ${needle}`);
    }

    if (url.includes("marketplace.json")) {
      if (config.marketplace === undefined) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(config.marketplace), { status: 200 });
    }

    if (config.raw && url in config.raw) {
      return new Response(config.raw[url], { status: 200 });
    }

    if (url.includes("/contents")) {
      const key = listingKey(url);
      const entries = config.listings?.[key];
      if (!entries) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(entries), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("unexpected url: " + url, { status: 500 });
  }) as FetchLike;
}

/** Derive the `<owner>/<repo>[/<path>]` listing key from a contents URL. */
function listingKey(url: string): string {
  const afterRepos = url.split("/repos/")[1] ?? "";
  const [ownerRepo, rest = ""] = splitOnce(afterRepos, "/contents");
  const pathPart = rest.split("?")[0] ?? ""; // leading "/" or ""
  return `${ownerRepo}${pathPart}`;
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  if (i === -1) return [s, ""];
  return [s.slice(0, i), s.slice(i + sep.length)];
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "plugin-details-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("getPluginDetails", () => {
  test("resolves an external plugin: manifest metadata + repo README/package.json", async () => {
    // GIVEN a marketplace entry for an external, not-installed plugin
    const fetch = makeFetch({
      marketplace: {
        name: "vellum",
        plugins: [
          {
            name: "caveman",
            source: {
              source: "github",
              repo: "example-org/caveman",
              ref: "1111111111111111111111111111111111111111",
            },
            description: "manifest description",
            homepage: "https://example.com/caveman",
            license: "MIT",
          },
        ],
      },
      // AND the external repo root lists a README and package.json
      listings: {
        "example-org/caveman": [
          fileEntry("README.md", "raw://caveman/readme"),
          fileEntry("package.json", "raw://caveman/pkg"),
        ],
      },
      raw: {
        "raw://caveman/readme": "# Caveman\n\nGrug brain plugin.",
        "raw://caveman/pkg": JSON.stringify({
          version: "1.8.2",
          description: "package description",
          homepage: "https://pkg.example.com",
        }),
      },
    });

    // WHEN we resolve the detail view at a ref
    const details = await getPluginDetails(
      { name: "caveman", ref: "v1" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the source is the external repo and the README comes from it
    expect(details.source).toEqual({
      kind: "github",
      repo: "example-org/caveman",
      ref: "1111111111111111111111111111111111111111",
    });
    expect(details.installed).toBe(false);
    expect(details.readme).toContain("Grug brain plugin");
    // AND manifest fields win over the repo package.json for description/homepage
    expect(details.description).toBe("manifest description");
    expect(details.homepage).toBe("https://example.com/caveman");
    expect(details.license).toBe("MIT");
    // AND version falls back to the repo package.json (manifest has none)
    expect(details.version).toBe("1.8.2");
    expect(details.ref).toBe("v1");
  });

  test("reads an external plugin at its pinned source ref, not the catalog ref", async () => {
    // GIVEN a marketplace entry pinned to a ref that differs from the catalog
    // ref the detail view is resolved at
    const marketplace = {
      name: "vellum",
      plugins: [
        {
          name: "caveman",
          source: {
            source: "github",
            repo: "example-org/caveman",
            ref: "2222222222222222222222222222222222222222",
          },
        },
      ],
    };
    // AND a fetch that records the ref query param of every contents request
    const contentsRefs = new Map<string, string>();
    const fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("marketplace.json")) {
        return new Response(JSON.stringify(marketplace), { status: 200 });
      }
      if (url.includes("/contents")) {
        const ref = new URL(url).searchParams.get("ref") ?? "";
        const key = url.includes("example-org/caveman") ? "external" : "other";
        contentsRefs.set(key, ref);
        if (key === "external") {
          return new Response(
            JSON.stringify([fileEntry("README.md", "raw://caveman/readme")]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }
      if (url === "raw://caveman/readme") {
        return new Response("# Caveman", { status: 200 });
      }
      return new Response("unexpected url: " + url, { status: 500 });
    }) as FetchLike;

    // WHEN we resolve the detail view at the catalog ref `main`
    const details = await getPluginDetails(
      { name: "caveman", ref: "main" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the external repo is read at the plugin's pinned ref, not `main`
    expect(contentsRefs.get("external")).toBe(
      "2222222222222222222222222222222222222222",
    );
    // AND the pinned external repo is the only contents request — no other
    // GitHub lookups are made for the name
    expect(contentsRefs.has("other")).toBe(false);
    // AND the README from the pinned ref is surfaced
    expect(details.readme).toContain("Caveman");
  });

  test("resolves the external marketplace source for an uninstalled plugin", async () => {
    // GIVEN a marketplace entry for "simple-memory" and no installed copy
    const fetch = makeFetch({
      marketplace: {
        name: "vellum",
        plugins: [
          {
            name: "simple-memory",
            source: {
              source: "github",
              repo: "example-org/simple-memory",
              ref: "9999999999999999999999999999999999999999",
            },
          },
        ],
      },
      listings: {
        "example-org/simple-memory": [
          fileEntry("README.md", "raw://ext/readme"),
        ],
      },
      raw: { "raw://ext/readme": "# Simple Memory (external)" },
    });

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "simple-memory" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the external marketplace source is used
    expect(details.source).toEqual({
      kind: "github",
      repo: "example-org/simple-memory",
      ref: "9999999999999999999999999999999999999999",
    });
    expect(details.readme).toContain("external");
  });

  test("prefers an installed copy's README and package.json over the repo", async () => {
    // GIVEN an installed copy on disk with its own README + package.json
    const target = join(workspace, "caveman");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "README.md"), "# Installed Caveman");
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ version: "2.0.0", license: "Apache-2.0" }),
    );

    // AND a marketplace entry + external repo that would otherwise be used
    const fetch = makeFetch({
      marketplace: {
        name: "vellum",
        plugins: [
          {
            name: "caveman",
            source: {
              source: "github",
              repo: "example-org/caveman",
              ref: "1111111111111111111111111111111111111111",
            },
            description: "manifest description",
          },
        ],
      },
      listings: {
        "example-org/caveman": [fileEntry("README.md", "raw://caveman/readme")],
      },
      raw: { "raw://caveman/readme": "# Remote Caveman" },
    });

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "caveman" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the installed README + version/license win; manifest fills the gap
    expect(details.installed).toBe(true);
    expect(details.readme).toBe("# Installed Caveman");
    expect(details.version).toBe("2.0.0");
    expect(details.license).toBe("Apache-2.0");
    expect(details.description).toBe("manifest description");
    // AND a package.json without vellum.icon surfaces icon as null
    expect(details.icon).toBeNull();
  });

  test("surfaces the installed copy's vellum.icon", async () => {
    // GIVEN an installed copy whose package.json declares vellum.icon
    const target = join(workspace, "caveman");
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ version: "2.0.0", vellum: { icon: "🦴" } }),
    );

    const fetch = makeFetch({
      marketplace: {
        name: "vellum",
        plugins: [{ name: "caveman", description: "d" }],
      },
      listings: {},
      raw: {},
    });

    const details = await getPluginDetails(
      { name: "caveman" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the author emoji is surfaced from the installed package.json
    expect(details.installed).toBe(true);
    expect(details.icon).toBe("🦴");
  });

  test("throws PluginDetailsNotFoundError when nothing claims the name", async () => {
    // GIVEN no installed copy and an empty marketplace
    const fetch = makeFetch({
      marketplace: { name: "vellum", plugins: [] },
    });

    // WHEN / THEN resolving an unknown name rejects with the not-found error
    await expect(
      getPluginDetails(
        { name: "ghost" },
        { fetch, workspacePluginsDir: workspace },
      ),
    ).rejects.toBeInstanceOf(PluginDetailsNotFoundError);
  });

  test("degrades to manifest metadata when the repo listing fails", async () => {
    // GIVEN a marketplace entry whose external repo listing errors out
    const fetch = makeFetch({
      marketplace: {
        name: "vellum",
        plugins: [
          {
            name: "caveman",
            source: {
              source: "github",
              repo: "example-org/caveman",
              ref: "1111111111111111111111111111111111111111",
            },
            description: "manifest description",
            license: "MIT",
          },
        ],
      },
      failOn: ["example-org/caveman"],
    });

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "caveman", ref: "v1" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN it still renders manifest metadata with a null README rather than throwing
    expect(details.readme).toBeNull();
    expect(details.description).toBe("manifest description");
    expect(details.license).toBe("MIT");
    expect(details.source).toEqual({
      kind: "github",
      repo: "example-org/caveman",
      ref: "1111111111111111111111111111111111111111",
    });
  });

  test("rejects an invalid (path-traversal) plugin name", async () => {
    // GIVEN a name that fails the install-name sanitizer
    const fetch = makeFetch({ marketplace: { name: "vellum", plugins: [] } });

    // WHEN / THEN resolution throws before any lookup
    await expect(
      getPluginDetails(
        { name: "../escape" },
        { fetch, workspacePluginsDir: workspace },
      ),
    ).rejects.toThrow();
  });

  test("surfaces a well-formed vellum.artifact from the repo package.json", async () => {
    // GIVEN an external plugin whose repo package.json declares a complete
    // vellum.artifact (https url + 64-hex sha256)
    const sha = "a".repeat(64);
    const fetch = makeFetch({
      marketplace: {
        name: "vellum",
        plugins: [
          {
            name: "dynamic-notch",
            source: {
              source: "github",
              repo: "example-org/dynamic-notch",
              ref: "1111111111111111111111111111111111111111",
            },
          },
        ],
      },
      listings: {
        "example-org/dynamic-notch": [
          fileEntry("package.json", "raw://notch/pkg"),
        ],
      },
      raw: {
        "raw://notch/pkg": JSON.stringify({
          version: "1.0.0",
          vellum: {
            artifact: {
              url: "https://example.com/releases/v1.0.0/App.dmg",
              sha256: sha,
              label: "Download for macOS",
            },
          },
        }),
      },
    });

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "dynamic-notch" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the artifact descriptor is surfaced, including its optional label
    expect(details.artifact).toEqual({
      url: "https://example.com/releases/v1.0.0/App.dmg",
      sha256: sha,
      label: "Download for macOS",
    });
  });

  test("an installed copy's artifact wins over the repo's", async () => {
    // GIVEN an installed copy whose package.json declares its own artifact
    const localSha = "b".repeat(64);
    const remoteSha = "c".repeat(64);
    const target = join(workspace, "dynamic-notch");
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({
        vellum: {
          artifact: {
            url: "https://example.com/local/App.dmg",
            sha256: localSha,
          },
        },
      }),
    );

    // AND a marketplace entry + repo package.json declaring a different artifact
    const fetch = makeFetch({
      marketplace: {
        name: "vellum",
        plugins: [
          {
            name: "dynamic-notch",
            source: {
              source: "github",
              repo: "example-org/dynamic-notch",
              ref: "1111111111111111111111111111111111111111",
            },
          },
        ],
      },
      listings: {
        "example-org/dynamic-notch": [
          fileEntry("package.json", "raw://notch/pkg"),
        ],
      },
      raw: {
        "raw://notch/pkg": JSON.stringify({
          vellum: {
            artifact: {
              url: "https://example.com/remote/App.dmg",
              sha256: remoteSha,
            },
          },
        }),
      },
    });

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "dynamic-notch" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the installed copy's artifact wins
    expect(details.artifact).toEqual({
      url: "https://example.com/local/App.dmg",
      sha256: localSha,
    });
  });

  test("treats a placeholder sha256 as no artifact yet", async () => {
    // GIVEN a repo package.json with a url but an empty (placeholder) sha256 —
    // the bootstrap state before a release workflow fills the digest in
    const fetch = makeFetch({
      marketplace: {
        name: "vellum",
        plugins: [
          {
            name: "dynamic-notch",
            source: {
              source: "github",
              repo: "example-org/dynamic-notch",
              ref: "1111111111111111111111111111111111111111",
            },
          },
        ],
      },
      listings: {
        "example-org/dynamic-notch": [
          fileEntry("package.json", "raw://notch/pkg"),
        ],
      },
      raw: {
        "raw://notch/pkg": JSON.stringify({
          vellum: {
            artifact: {
              url: "https://example.com/releases/v1.0.0/App.dmg",
              sha256: "",
            },
          },
        }),
      },
    });

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "dynamic-notch" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN no artifact is surfaced (a client must not offer an unverifiable download)
    expect(details.artifact).toBeNull();
  });
});
