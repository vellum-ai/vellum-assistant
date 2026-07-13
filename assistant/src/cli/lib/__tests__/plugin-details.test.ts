/**
 * Tests for {@link getPluginDetails}.
 *
 * The catalog entry is resolved from the gated plugin catalog (the same source
 * search and install-by-name use): these tests run with platform features
 * disabled (`VELLUM_DISABLE_PLATFORM`) so the catalog is the bundled manifest —
 * real plugin names / pinned SHAs, zero network. GitHub is replaced with an
 * in-memory Contents API fixture passed via the `fetch` dependency, and the
 * installed-copy path is exercised against a real temp directory passed via
 * `workspacePluginsDir` — no globals are monkey-patched. The fixture answers two
 * URL shapes:
 *   - directory listings (`/contents/<path>` → entry array or 404),
 *   - raw file downloads (a listing entry's `download_url`).
 *
 * A separate suite drives the platform-enabled path with a failing catalog
 * fetch to prove the detail view degrades (local + repo fallback) on an outage.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { FetchLike } from "../fetch-like.js";
import { invalidatePluginCatalogCache } from "../plugin-catalog-cache.js";
import { readBundledPluginCatalog } from "../plugin-catalog-local.js";
import {
  getPluginDetails,
  PluginDetailsNotFoundError,
} from "../plugin-details.js";
import type { PluginSearchMatch } from "../search-plugins.js";

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

/** The bundled catalog entry for {@link name} — the source under test. */
function bundledMatch(name: string): PluginSearchMatch {
  const match = readBundledPluginCatalog().matches.find((m) => m.name === name);
  if (!match) throw new Error(`bundled catalog has no entry for "${name}"`);
  return match;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Build a minimal, well-formed PNG with a valid signature and IHDR dimensions. */
function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  PNG_SIGNATURE.copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write("IHDR", 12, "ascii"); // IHDR chunk type
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function sha16(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

const ORIGINAL_ENV = {
  IS_PLATFORM: process.env.IS_PLATFORM,
  VELLUM_DISABLE_PLATFORM: process.env.VELLUM_DISABLE_PLATFORM,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

let workspace: string;

describe("getPluginDetails (bundled catalog, offline)", () => {
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "plugin-details-"));
    invalidatePluginCatalogCache();
    process.env.VELLUM_DISABLE_PLATFORM = "true";
    delete process.env.IS_PLATFORM;
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    restoreEnv();
  });

  test("resolves an external plugin: catalog metadata + repo README/package.json", async () => {
    // GIVEN a known bundled catalog plugin, not installed locally
    const caveman = bundledMatch("caveman");
    const fetch = makeFetch({
      // AND its external repo root lists a README and package.json
      listings: {
        [caveman.source.repo]: [
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

    // THEN the source is the catalog's pinned origin and the README comes from it
    expect(details.source).toEqual(caveman.source);
    expect(details.installed).toBe(false);
    expect(details.readme).toContain("Grug brain plugin");
    // AND catalog fields win over the repo package.json for description/homepage
    expect(details.description).toBe(caveman.description ?? null);
    expect(details.homepage).toBe(caveman.homepage ?? null);
    expect(details.license).toBe(caveman.license ?? null);
    // AND version falls back to the repo package.json (the catalog carries none)
    expect(details.version).toBe("1.8.2");
    expect(details.ref).toBe("v1");
  });

  test("reads an external plugin at its pinned source ref, not the catalog ref", async () => {
    // GIVEN a bundled catalog entry pinned to a full-SHA source ref
    const caveman = bundledMatch("caveman");
    // AND a fetch that records the ref query param of every contents request
    const contentsRefs = new Map<string, string>();
    const fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/contents")) {
        const ref = new URL(url).searchParams.get("ref") ?? "";
        const key = url.includes(caveman.source.repo) ? "external" : "other";
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

    // WHEN we resolve the detail view at a catalog ref that isn't the pin
    const details = await getPluginDetails(
      { name: "caveman", ref: "main" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the external repo is read at the plugin's pinned SHA, not the ref
    expect(contentsRefs.get("external")).toBe(caveman.source.ref);
    // AND the pinned external repo is the only contents request
    expect(contentsRefs.has("other")).toBe(false);
    // AND the README from the pinned ref is surfaced
    expect(details.readme).toContain("Caveman");
  });

  test("resolves the external catalog source for an uninstalled plugin", async () => {
    // GIVEN a bundled catalog entry and no installed copy
    const simpleMemory = bundledMatch("simple-memory");
    const fetch = makeFetch({
      listings: {
        [simpleMemory.source.repo]: [
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

    // THEN the external catalog source is used
    expect(details.source).toEqual(simpleMemory.source);
    expect(details.readme).toContain("external");
  });

  test("prefers an installed copy's README and package.json over the repo", async () => {
    // GIVEN an installed copy on disk with its own README + package.json
    const caveman = bundledMatch("caveman");
    const target = join(workspace, "caveman");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "README.md"), "# Installed Caveman");
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ version: "2.0.0", license: "Apache-2.0" }),
    );

    // AND an external repo that would otherwise be used
    const fetch = makeFetch({
      listings: {
        [caveman.source.repo]: [
          fileEntry("README.md", "raw://caveman/readme"),
        ],
      },
      raw: { "raw://caveman/readme": "# Remote Caveman" },
    });

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "caveman" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the installed README + version/license win; the catalog fills the gap
    expect(details.installed).toBe(true);
    expect(details.readme).toBe("# Installed Caveman");
    expect(details.version).toBe("2.0.0");
    expect(details.license).toBe("Apache-2.0");
    expect(details.description).toBe(caveman.description ?? null);
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

    const fetch = makeFetch({});

    const details = await getPluginDetails(
      { name: "caveman" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the author emoji is surfaced from the installed package.json
    expect(details.installed).toBe(true);
    expect(details.icon).toBe("🦴");
  });

  test("surfaces hasIcon + iconVersion from the installed copy's icon.png", async () => {
    // GIVEN an installed copy that ships a valid bundled icon.png
    const target = join(workspace, "caveman");
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ version: "2.0.0" }),
    );
    const png = makePng(64, 64);
    writeFileSync(join(target, "icon.png"), png);

    const fetch = makeFetch({});

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "caveman" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the validated icon presence + content-hash version are surfaced
    expect(details.installed).toBe(true);
    expect(details.hasIcon).toBe(true);
    expect(details.iconVersion).toBe(sha16(png));
  });

  test("reports hasIcon false + null iconVersion when no bundled icon.png", async () => {
    // GIVEN an installed copy with no icon.png
    const target = join(workspace, "caveman");
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ version: "2.0.0" }),
    );

    const fetch = makeFetch({});

    const details = await getPluginDetails(
      { name: "caveman" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN no icon is surfaced (fail-closed) — a client offers no bundled image
    expect(details.hasIcon).toBe(false);
    expect(details.iconVersion).toBeNull();
  });

  test("reports hasIcon false + null iconVersion for an uninstalled plugin", async () => {
    // GIVEN a catalog-only plugin with no installed copy
    const simpleMemory = bundledMatch("simple-memory");
    const fetch = makeFetch({ listings: { [simpleMemory.source.repo]: [] } });

    const details = await getPluginDetails(
      { name: "simple-memory" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN a not-installed plugin has no bundled icon to validate
    expect(details.installed).toBe(false);
    expect(details.hasIcon).toBe(false);
    expect(details.iconVersion).toBeNull();
  });

  test("throws PluginDetailsNotFoundError when nothing claims the name", async () => {
    // GIVEN no installed copy and a name absent from the bundled catalog
    const fetch = makeFetch({});

    // WHEN / THEN resolving an unknown name rejects with the not-found error
    await expect(
      getPluginDetails(
        { name: "no-such-ghost-plugin" },
        { fetch, workspacePluginsDir: workspace },
      ),
    ).rejects.toBeInstanceOf(PluginDetailsNotFoundError);
  });

  test("degrades to catalog metadata when the repo listing fails", async () => {
    // GIVEN a catalog entry whose external repo listing errors out
    const caveman = bundledMatch("caveman");
    const fetch = makeFetch({ failOn: [caveman.source.repo] });

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "caveman", ref: "v1" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN it still renders catalog metadata with a null README rather than throwing
    expect(details.readme).toBeNull();
    expect(details.description).toBe(caveman.description ?? null);
    expect(details.license).toBe(caveman.license ?? null);
    expect(details.source).toEqual(caveman.source);
  });

  test("rejects an invalid (path-traversal) plugin name", async () => {
    // GIVEN a name that fails the install-name sanitizer
    const fetch = makeFetch({});

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
    const notch = bundledMatch("dynamic-notch");
    const sha = "a".repeat(64);
    const fetch = makeFetch({
      listings: {
        [notch.source.repo]: [fileEntry("package.json", "raw://notch/pkg")],
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
    const notch = bundledMatch("dynamic-notch");
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

    // AND a repo package.json declaring a different artifact
    const fetch = makeFetch({
      listings: {
        [notch.source.repo]: [fileEntry("package.json", "raw://notch/pkg")],
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
    const notch = bundledMatch("dynamic-notch");
    const fetch = makeFetch({
      listings: {
        [notch.source.repo]: [fileEntry("package.json", "raw://notch/pkg")],
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

describe("getPluginDetails (catalog unavailable, platform enabled)", () => {
  // A fetch that always rejects — the platform catalog fetch fails, and no
  // GitHub enrichment should be attempted for the degraded cases below.
  const failingFetch = (async () => {
    throw new Error("network down");
  }) as FetchLike;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "plugin-details-"));
    invalidatePluginCatalogCache();
    delete process.env.IS_PLATFORM;
    delete process.env.VELLUM_DISABLE_PLATFORM;
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    invalidatePluginCatalogCache();
    restoreEnv();
  });

  test("an installed copy still renders from disk when the catalog is down", async () => {
    // GIVEN an installed copy on disk and a catalog that fails to resolve
    const target = join(workspace, "caveman");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "README.md"), "# Installed Caveman");
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({
        version: "2.0.0",
        description: "local description",
        license: "Apache-2.0",
      }),
    );

    // WHEN we resolve the detail view
    const details = await getPluginDetails(
      { name: "caveman" },
      { fetch: failingFetch, workspacePluginsDir: workspace },
    );

    // THEN it degrades to the on-disk metadata rather than throwing; with no
    // catalog entry there is no advertised source to enrich from
    expect(details.installed).toBe(true);
    expect(details.readme).toBe("# Installed Caveman");
    expect(details.version).toBe("2.0.0");
    expect(details.description).toBe("local description");
    expect(details.license).toBe("Apache-2.0");
    expect(details.source).toBeNull();
  });

  test("a not-installed, unresolved name still throws PluginDetailsNotFoundError", async () => {
    // GIVEN no installed copy and a catalog that fails to resolve
    // WHEN / THEN a name that nothing on disk claims still 404s
    await expect(
      getPluginDetails(
        { name: "caveman" },
        { fetch: failingFetch, workspacePluginsDir: workspace },
      ),
    ).rejects.toBeInstanceOf(PluginDetailsNotFoundError);
  });
});
